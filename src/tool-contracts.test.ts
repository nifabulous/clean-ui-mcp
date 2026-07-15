import { describe, expect, it } from "vitest";
import {
  RetrievalMode,
  RetrievalModality,
  FallbackReason,
  RetrievalState,
  ToolResultEnvelope,
  isAllowedRetrievalState,
  Evidence,
  EvidenceKind,
  EvidenceBasis,
  ToolError,
  ToolInputSchemas,
  ToolDataSchemas,
  getToolDataSchema,
  getToolEvidenceRequired,
  parseToolResult,
  UiSpec,
  ALLOWED_RETRIEVAL_STATES,
} from "./tool-contracts.js";
import { TOOL_CATALOG } from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// Retrieval state matrix
// ---------------------------------------------------------------------------

describe("RetrievalMode", () => {
  it("accepts the five approved modes", () => {
    for (const mode of ["hybrid", "vector", "keyword", "structured-fallback", "none"]) {
      expect(RetrievalMode.safeParse(mode).success).toBe(true);
    }
  });
  it("rejects unknown modes including 'image-vector'", () => {
    expect(RetrievalMode.safeParse("image-vector").success).toBe(false);
  });
});

describe("RetrievalModality", () => {
  it("accepts the four modalities", () => {
    for (const m of ["text", "image", "metadata", "none"]) {
      expect(RetrievalModality.safeParse(m).success).toBe(true);
    }
  });
});

describe("FallbackReason", () => {
  it("accepts the six reasons", () => {
    for (const r of [
      "missing-index", "incompatible-index", "missing-provider-key",
      "community-edition", "provider-error", "no-image-evidence",
    ]) {
      expect(FallbackReason.safeParse(r).success).toBe(true);
    }
  });
});

// ---- Complete mode × modality matrix ----

describe("RetrievalState — allowed mode × modality combinations", () => {
  const base = { fallbackUsed: false, resultCount: 5 };
  it("accepts hybrid + text", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "hybrid", modality: "text" }).success).toBe(true);
  });
  it("accepts vector + text", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "vector", modality: "text" }).success).toBe(true);
  });
  it("accepts vector + image", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "vector", modality: "image" }).success).toBe(true);
  });
  it("accepts keyword + text", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "keyword", modality: "text" }).success).toBe(true);
  });
  it("accepts keyword + metadata", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "keyword", modality: "metadata" }).success).toBe(true);
  });
  it("accepts structured-fallback + metadata", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "structured-fallback", modality: "metadata", fallbackUsed: true, fallbackReason: "community-edition", attemptedModes: ["vector"] }).success).toBe(true);
  });
  it("accepts none + none", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "none", modality: "none", resultCount: 0 }).success).toBe(true);
  });
});

describe("RetrievalState — forbidden mode × modality combinations", () => {
  const base = { fallbackUsed: false, resultCount: 5 };
  it("rejects none + text", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "none", modality: "text" }).success).toBe(false);
  });
  it("rejects none + image", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "none", modality: "image" }).success).toBe(false);
  });
  it("rejects none + metadata", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "none", modality: "metadata" }).success).toBe(false);
  });
  it("rejects keyword + image", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "keyword", modality: "image" }).success).toBe(false);
  });
  it("rejects keyword + none", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "keyword", modality: "none" }).success).toBe(false);
  });
  it("rejects hybrid + none", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "hybrid", modality: "none" }).success).toBe(false);
  });
  it("rejects vector + none", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "vector", modality: "none" }).success).toBe(false);
  });
  it("rejects hybrid + image", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "hybrid", modality: "image" }).success).toBe(false);
  });
  it("rejects structured-fallback + text", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "structured-fallback", modality: "text" }).success).toBe(false);
  });
  it("rejects structured-fallback + none", () => {
    expect(RetrievalState.safeParse({ ...base, mode: "structured-fallback", modality: "none" }).success).toBe(false);
  });
});

// ---- Fallback invariants ----

describe("RetrievalState — fallback invariants", () => {
  it("rejects fallbackUsed without fallbackReason", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, resultCount: 3 }).success).toBe(false);
  });
  it("rejects fallbackReason without fallbackUsed", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: false, resultCount: 3, fallbackReason: "missing-index" }).success).toBe(false);
  });
  it("rejects fallbackUsed without attemptedModes", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3 }).success).toBe(false);
  });
  it("rejects attemptedModes empty array with fallback", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: [] }).success).toBe(false);
  });
  it("rejects attemptedModes containing 'none'", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["none"] }).success).toBe(false);
  });
  it("rejects attemptedModes with duplicates", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["vector", "vector"] }).success).toBe(false);
  });
  it("rejects vector mode with missing-index fallback (contradictory)", () => {
    expect(RetrievalState.safeParse({ mode: "vector", modality: "image", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["vector"] }).success).toBe(false);
  });
  it("rejects none mode with fallbackUsed true", () => {
    expect(RetrievalState.safeParse({ mode: "none", modality: "none", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 0, attemptedModes: ["vector"] }).success).toBe(false);
  });
  it("rejects structured-fallback without fallbackReason", () => {
    expect(RetrievalState.safeParse({ mode: "structured-fallback", modality: "metadata", fallbackUsed: true, resultCount: 3, attemptedModes: ["vector"] }).success).toBe(false);
  });
});

// ---- resultCount ----

describe("RetrievalState — resultCount", () => {
  it("requires resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
  it("accepts zero resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 }).success).toBe(true);
  });
  it("rejects negative resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: -1 }).success).toBe(false);
  });
});

// ---- Per-tool allowed retrieval states ----

describe("ALLOWED_RETRIEVAL_STATES — per-tool constraints", () => {
  it("get_ui_taxonomy only allows structured-fallback + metadata or none", () => {
    const states = ALLOWED_RETRIEVAL_STATES["get_ui_taxonomy"];
    // Every allowed state is either structured-fallback+metadata or none+none
    expect(states.every((s) =>
      (s.mode === "structured-fallback" && s.modality === "metadata") ||
      (s.mode === "none" && s.modality === "none"),
    )).toBe(true);
  });
  it("get_ui_taxonomy does NOT allow image-vector retrieval", () => {
    const states = ALLOWED_RETRIEVAL_STATES["get_ui_taxonomy"];
    expect(states.some((s) => s.mode === "vector" && s.modality === "image")).toBe(false);
  });
  it("search_ui_references allows hybrid/vector/keyword + text", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["search_ui_references"].map((s) => s.mode);
    expect(modes).toContain("hybrid");
    expect(modes).toContain("vector");
    expect(modes).toContain("keyword");
  });
  it("critique_ui allows structured-fallback + metadata", () => {
    const states = ALLOWED_RETRIEVAL_STATES["critique_ui"];
    expect(states.some((s) => s.mode === "structured-fallback")).toBe(true);
  });
  it("every tool has at least one allowed state", () => {
    for (const tool of TOOL_CATALOG) {
      expect(ALLOWED_RETRIEVAL_STATES[tool]).toBeDefined();
      expect(ALLOWED_RETRIEVAL_STATES[tool].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence — approved model
// ---------------------------------------------------------------------------

describe("EvidenceKind", () => {
  it("accepts the five kind values", () => {
    for (const k of ["corpus-observation", "screen-observation", "dom-signal", "machine-rule", "editorial-guidance"]) {
      expect(EvidenceKind.safeParse(k).success).toBe(true);
    }
  });
});

describe("EvidenceBasis", () => {
  it("accepts the four basis values", () => {
    for (const b of ["visible", "inferred", "dom-grounded", "editorial"]) {
      expect(EvidenceBasis.safeParse(b).success).toBe(true);
    }
  });
});

describe("Evidence — semantic constraints", () => {
  it("accepts corpus-observation with referenceId and visible basis", () => {
    expect(Evidence.safeParse({
      id: "ev-1", referenceId: "stripe-dashboard",
      kind: "corpus-observation", summary: "12-column grid", basis: "visible",
    }).success).toBe(true);
  });
  it("accepts machine-rule without referenceId (editorial basis)", () => {
    expect(Evidence.safeParse({
      id: "ev-2", kind: "machine-rule",
      summary: "WCAG 1.4.3 requires 4.5:1 contrast", basis: "editorial",
    }).success).toBe(true);
  });
  it("rejects corpus-observation WITHOUT referenceId", () => {
    expect(Evidence.safeParse({
      id: "ev-3", kind: "corpus-observation",
      summary: "uses a sidebar", basis: "visible",
    }).success).toBe(false);
  });
  it("rejects dom-signal with editorial basis (DOM signals are dom-grounded or visible)", () => {
    expect(Evidence.safeParse({
      id: "ev-4", kind: "dom-signal",
      summary: "data-testid found", basis: "editorial",
    }).success).toBe(false);
  });
  it("rejects editorial-guidance with visible basis (editorial is never visible)", () => {
    expect(Evidence.safeParse({
      id: "ev-5", kind: "editorial-guidance",
      summary: "use 8px spacing", basis: "visible",
    }).success).toBe(false);
  });
  it("requires id", () => {
    expect(Evidence.safeParse({ referenceId: "x", kind: "corpus-observation", summary: "x", basis: "visible" }).success).toBe(false);
  });
  it("requires summary", () => {
    expect(Evidence.safeParse({ id: "ev-1", kind: "corpus-observation", basis: "visible" }).success).toBe(false);
  });
  it("strict-rejects unknown keys", () => {
    expect(Evidence.safeParse({ id: "ev-1", kind: "corpus-observation", summary: "x", basis: "visible", extra: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolError
// ---------------------------------------------------------------------------

describe("ToolError", () => {
  it("accepts a valid error", () => {
    expect(ToolError.safeParse({ code: "NOT_FOUND", message: "x", retryable: false }).success).toBe(true);
  });
  it("requires all three fields", () => {
    expect(ToolError.safeParse({ code: "ERR", message: "x" }).success).toBe(false);
  });
  it("strict-rejects unknown keys", () => {
    expect(ToolError.safeParse({ code: "ERR", message: "x", retryable: false, extra: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-tool input schemas — exact key coverage
// ---------------------------------------------------------------------------

describe("ToolInputSchemas", () => {
  it("has a schema for every tool in TOOL_CATALOG", () => {
    expect(Object.keys(ToolInputSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
  it("search_ui_references input has query, category, styleTag, limit", () => {
    const schema = ToolInputSchemas["search_ui_references"];
    expect(schema.safeParse({ query: "dashboard" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true); // all optional
  });
  it("get_ui_reference input requires id", () => {
    const schema = ToolInputSchemas["get_ui_reference"];
    expect(schema.safeParse({ id: "x" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });
  it("compare_ui_references input requires ids array min 2", () => {
    const schema = ToolInputSchemas["compare_ui_references"];
    expect(schema.safeParse({ ids: ["a", "b"] }).success).toBe(true);
    expect(schema.safeParse({ ids: ["a"] }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-tool data schemas — exact key coverage and enforcement
// ---------------------------------------------------------------------------

describe("ToolDataSchemas — key coverage", () => {
  it("has exactly the same keys as TOOL_CATALOG", () => {
    expect(Object.keys(ToolDataSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
});

describe("getToolEvidenceRequired", () => {
  it("returns true for synthesis tools", () => {
    expect(getToolEvidenceRequired("plan_ui_direction")).toBe(true);
    expect(getToolEvidenceRequired("create_ui_spec")).toBe(true);
    expect(getToolEvidenceRequired("critique_ui")).toBe(true);
  });
  it("returns false for non-evidence tools", () => {
    expect(getToolEvidenceRequired("search_ui_references")).toBe(false);
    expect(getToolEvidenceRequired("get_ui_taxonomy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UiSpec — complete create_ui_spec output schema
// ---------------------------------------------------------------------------

describe("UiSpec", () => {
  function minimalValidUiSpec() {
    return {
      designDirection: "A calm dashboard with clear visual hierarchy",
      rejectedDefaults: [],
      layoutRegions: [],
      componentInventory: [],
      colorTokens: { primary: "#3b82f6", surface: "#ffffff", ink: "#1e293b", muted: "#64748b" },
      typographyTokens: { heading: "Inter, sans-serif", body: "Inter, sans-serif", mono: "JetBrains Mono, monospace" },
      motionGuidance: { notes: [], evidenceUnavailable: true },
      accessibilityConstraints: [],
      contentVoiceGuidance: undefined,
      techniques: [],
      antiPatterns: [],
      frameworkNotes: undefined,
      acceptanceCriteria: ["Contrast ratio meets WCAG AA"],
      citedReferences: [],
      authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
    };
  }

  it("accepts a minimal valid UiSpec", () => {
    expect(UiSpec.safeParse(minimalValidUiSpec()).success).toBe(true);
  });

  it("requires designDirection", () => {
    const bad = { ...minimalValidUiSpec() };
    delete (bad as Record<string, unknown>).designDirection;
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("requires colorTokens with primary, surface, ink, muted", () => {
    const bad = { ...minimalValidUiSpec(), colorTokens: { primary: "#000" } };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("requires typographyTokens with heading, body, mono", () => {
    const bad = { ...minimalValidUiSpec(), typographyTokens: { heading: "Inter" } };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("requires acceptanceCriteria as a non-empty array", () => {
    const bad = { ...minimalValidUiSpec(), acceptanceCriteria: [] };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("requires authorityLanes with corpusEvidence, machineRules, editorialGuidance", () => {
    const bad = { ...minimalValidUiSpec(), authorityLanes: { corpusEvidence: [] } };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("accepts motionGuidance with evidenceUnavailable true (sparse state)", () => {
    expect(UiSpec.safeParse(minimalValidUiSpec()).success).toBe(true);
  });

  it("strict-rejects unknown keys", () => {
    const bad = { ...minimalValidUiSpec(), unexpected: true };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseToolResult — per-tool data enforcement through the envelope
// ---------------------------------------------------------------------------

describe("parseToolResult — enforces per-tool data schema", () => {
  it("rejects search_ui_references data missing 'results' array", () => {
    const result = parseToolResult({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Found 3",
      data: { foo: "bar" }, // wrong shape — should be { results: [...] }
      referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 3 },
      warnings: [],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts search_ui_references with valid results array", () => {
    const result = parseToolResult({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Found 1",
      data: { results: [{ id: "ref-1" }] },
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 1 },
      warnings: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects create_ui_spec data that doesn't match UiSpec", () => {
    const result = parseToolResult({
      tool: "create_ui_spec",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Spec",
      data: { foo: "bar" }, // not a valid UiSpec
      referenceIds: ["ref-1"],
      retrieval: { mode: "structured-fallback", modality: "metadata", fallbackUsed: false, resultCount: 1 },
      warnings: [],
      evidence: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects get_ui_taxonomy with image-vector retrieval (not allowed for that tool)", () => {
    const result = parseToolResult({
      tool: "get_ui_taxonomy",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Taxonomy",
      data: {
        patternTypes: { count: 0, values: [] },
        categories: { count: 0, values: [] },
        styleTags: { count: 0, values: [] },
      },
      referenceIds: [],
      retrieval: { mode: "vector", modality: "image", fallbackUsed: false, resultCount: 0 },
      warnings: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects plan_ui_direction success without evidence", () => {
    const result = parseToolResult({
      tool: "plan_ui_direction",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Direction",
      data: { direction: "calm dashboard" },
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 1 },
      warnings: [],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts plan_ui_direction with evidence array (may be empty with warning)", () => {
    const result = parseToolResult({
      tool: "plan_ui_direction",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Direction",
      data: { direction: "calm dashboard" },
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 1 },
      warnings: ["Insufficient evidence for some claims"],
      evidence: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects search_ui_references with evidence (not an evidence tool)", () => {
    const result = parseToolResult({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Results",
      data: { results: [] },
      referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 },
      warnings: [],
      evidence: [{ id: "ev-1", kind: "corpus-observation", summary: "x", basis: "visible" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects evidence tool with empty evidence AND no insufficiency warning", () => {
    const result = parseToolResult({
      tool: "plan_ui_direction",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Direction",
      data: { direction: "x" },
      referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 },
      warnings: [], // no warning about insufficiency
      evidence: [], // empty
    });
    expect(result.ok).toBe(false);
  });

  it("accepts status error with null data and error", () => {
    const result = parseToolResult({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "error",
      summary: "Not found",
      data: null,
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 },
      warnings: [],
      error: { code: "NOT_FOUND", message: "No results", retryable: false },
    });
    expect(result.ok).toBe(true);
  });
});
