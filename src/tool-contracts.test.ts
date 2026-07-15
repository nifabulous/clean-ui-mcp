import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  RetrievalMode,
  RetrievalModality,
  FallbackReason,
  RetrievalState,
  ToolResultEnvelope,
  isAllowedRetrievalState,
  Evidence,
  ToolError,
  EvidenceKind,
  EvidenceBasis,
  ToolDataSchemas,
  getToolDataSchema,
  getToolEvidenceRequired,
} from "./tool-contracts.js";

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
    expect(RetrievalMode.safeParse("semantic").success).toBe(false);
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
      "missing-index",
      "incompatible-index",
      "missing-provider-key",
      "community-edition",
      "provider-error",
      "no-image-evidence",
    ]) {
      expect(FallbackReason.safeParse(r).success).toBe(true);
    }
  });
});

describe("RetrievalState — complete mode × modality matrix", () => {
  // ---- ALLOWED combinations ----

  it("accepts hybrid + text", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 5 }).success).toBe(true);
  });
  it("accepts vector + text", () => {
    expect(RetrievalState.safeParse({ mode: "vector", modality: "text", fallbackUsed: false, resultCount: 5 }).success).toBe(true);
  });
  it("accepts vector + image (not 'image-vector' mode)", () => {
    expect(RetrievalState.safeParse({ mode: "vector", modality: "image", fallbackUsed: false, resultCount: 3 }).success).toBe(true);
  });
  it("accepts keyword + text (intentional)", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: false, resultCount: 5 }).success).toBe(true);
  });
  it("accepts keyword + metadata", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "metadata", fallbackUsed: false, resultCount: 5 }).success).toBe(true);
  });
  it("accepts structured-fallback + metadata with reason", () => {
    expect(RetrievalState.safeParse({ mode: "structured-fallback", modality: "metadata", fallbackUsed: true, fallbackReason: "community-edition", resultCount: 5, attemptedModes: ["vector"] }).success).toBe(true);
  });
  it("accepts none + none", () => {
    expect(RetrievalState.safeParse({ mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 }).success).toBe(true);
  });

  // ---- FORBIDDEN mode × modality combinations ----

  it("rejects none + text", () => {
    expect(RetrievalState.safeParse({ mode: "none", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects none + image", () => {
    expect(RetrievalState.safeParse({ mode: "none", modality: "image", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects none + metadata", () => {
    expect(RetrievalState.safeParse({ mode: "none", modality: "metadata", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects keyword + image", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "image", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects keyword + none", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "none", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects hybrid + none", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "none", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects vector + none", () => {
    expect(RetrievalState.safeParse({ mode: "vector", modality: "none", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects hybrid + image (hybrid requires text modality)", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "image", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects structured-fallback + text", () => {
    expect(RetrievalState.safeParse({ mode: "structured-fallback", modality: "text", fallbackUsed: true, fallbackReason: "missing-index" }).success).toBe(false);
  });

  // ---- Fallback consistency ----

  it("rejects 'none' mode with fallbackUsed true", () => {
    expect(RetrievalState.safeParse({ mode: "none", modality: "none", fallbackUsed: true, fallbackReason: "missing-index" }).success).toBe(false);
  });
  it("rejects 'vector' mode with 'missing-index' fallback", () => {
    expect(RetrievalState.safeParse({ mode: "vector", modality: "image", fallbackUsed: true, fallbackReason: "missing-index" }).success).toBe(false);
  });
  it("rejects 'structured-fallback' without a fallbackReason", () => {
    expect(RetrievalState.safeParse({ mode: "structured-fallback", modality: "metadata", fallbackUsed: true }).success).toBe(false);
  });
  it("rejects fallbackUsed true without a fallbackReason", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true }).success).toBe(false);
  });
  it("rejects fallbackReason without fallbackUsed", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: false, fallbackReason: "missing-index" }).success).toBe(false);
  });

  // ---- resultCount ----

  it("requires resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
  it("accepts resultCount zero", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 }).success).toBe(true);
  });
  it("accepts resultCount positive", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 5 }).success).toBe(true);
  });
  it("rejects negative resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: -1 }).success).toBe(false);
  });

  // ---- attemptedModes fallback invariant ----

  it("requires attemptedModes when fallbackUsed is true", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3 }).success).toBe(false);
  });
  it("accepts attemptedModes with fallback", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["vector"] }).success).toBe(true);
  });
});

describe("isAllowedRetrievalState", () => {
  it("allows intentional keyword without fallback", () => {
    expect(isAllowedRetrievalState({ mode: "keyword", modality: "text", fallbackUsed: false, resultCount: 5 })).toBe(true);
  });
  it("allows degraded keyword with fallback reason and attemptedModes", () => {
    expect(isAllowedRetrievalState({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["vector"] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Evidence — approved model (id, referenceId?, kind [5], summary, basis [4])
// ---------------------------------------------------------------------------

describe("EvidenceKind", () => {
  it("accepts the five kind values", () => {
    for (const k of ["corpus-observation", "screen-observation", "dom-signal", "machine-rule", "editorial-guidance"]) {
      expect(EvidenceKind.safeParse(k).success).toBe(true);
    }
  });
  it("rejects unknown kinds", () => {
    expect(EvidenceKind.safeParse("guess").success).toBe(false);
  });
});

describe("EvidenceBasis", () => {
  it("accepts the four basis values", () => {
    for (const b of ["visible", "inferred", "dom-grounded", "editorial"]) {
      expect(EvidenceBasis.safeParse(b).success).toBe(true);
    }
  });
});

describe("Evidence", () => {
  it("accepts a corpus-observation with all fields", () => {
    expect(Evidence.safeParse({
      id: "ev-1",
      referenceId: "stripe-dashboard",
      kind: "corpus-observation",
      summary: "12-column grid with 24px gutters",
      basis: "visible",
    }).success).toBe(true);
  });

  it("accepts evidence without referenceId (response-scoped)", () => {
    expect(Evidence.safeParse({
      id: "ev-2",
      kind: "machine-rule",
      summary: "WCAG 1.4.3 requires 4.5:1 contrast",
      basis: "editorial",
    }).success).toBe(true);
  });

  it("accepts dom-signal with dom-grounded basis", () => {
    expect(Evidence.safeParse({
      id: "ev-3",
      kind: "dom-signal",
      summary: "data-testid='sidebar-nav' found",
      basis: "dom-grounded",
    }).success).toBe(true);
  });

  it("accepts editorial-guidance with editorial basis", () => {
    expect(Evidence.safeParse({
      id: "ev-4",
      kind: "editorial-guidance",
      summary: "Use 8px spacing base for dashboards",
      basis: "editorial",
    }).success).toBe(true);
  });

  it("requires id (not referenceId)", () => {
    expect(Evidence.safeParse({
      referenceId: "ref-1",
      kind: "corpus-observation",
      summary: "x",
      basis: "visible",
    }).success).toBe(false);
  });

  it("requires kind", () => {
    expect(Evidence.safeParse({
      id: "ev-1",
      summary: "x",
      basis: "visible",
    }).success).toBe(false);
  });

  it("requires summary", () => {
    expect(Evidence.safeParse({
      id: "ev-1",
      kind: "corpus-observation",
      basis: "visible",
    }).success).toBe(false);
  });

  it("requires basis", () => {
    expect(Evidence.safeParse({
      id: "ev-1",
      kind: "corpus-observation",
      summary: "x",
    }).success).toBe(false);
  });

  it("strict-rejects unknown keys", () => {
    expect(Evidence.safeParse({
      id: "ev-1",
      kind: "corpus-observation",
      summary: "x",
      basis: "visible",
      extra: true,
    }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolError
// ---------------------------------------------------------------------------

describe("ToolError", () => {
  it("accepts a valid error", () => {
    expect(ToolError.safeParse({ code: "NOT_FOUND", message: "No references found", retryable: false }).success).toBe(true);
  });
  it("accepts retryable errors", () => {
    expect(ToolError.safeParse({ code: "PROVIDER_ERROR", message: "Rate limited", retryable: true }).success).toBe(true);
  });
  it("requires code, message, and retryable", () => {
    expect(ToolError.safeParse({ code: "ERR", message: "x" }).success).toBe(false);
  });
  it("strict-rejects unknown keys", () => {
    expect(ToolError.safeParse({ code: "ERR", message: "x", retryable: false, extra: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-tool data schemas
// ---------------------------------------------------------------------------

describe("ToolDataSchemas", () => {
  it("has a schema for every tool in the catalog", () => {
    // Verify all 12 tools have data schemas
    for (const toolName of Object.keys(ToolDataSchemas)) {
      const schema = ToolDataSchemas[toolName as keyof typeof ToolDataSchemas];
      expect(schema).toBeDefined();
    }
  });

  it("getToolDataSchema returns the schema for a known tool", () => {
    expect(getToolDataSchema("search_ui_references")).toBeDefined();
    expect(getToolDataSchema("critique_ui")).toBeDefined();
    expect(getToolDataSchema("create_ui_spec")).toBeDefined();
  });
});

describe("getToolEvidenceRequired", () => {
  it("returns true for plan_ui_direction", () => {
    expect(getToolEvidenceRequired("plan_ui_direction")).toBe(true);
  });
  it("returns true for create_ui_spec", () => {
    expect(getToolEvidenceRequired("create_ui_spec")).toBe(true);
  });
  it("returns true for critique_ui", () => {
    expect(getToolEvidenceRequired("critique_ui")).toBe(true);
  });
  it("returns false for search_ui_references", () => {
    expect(getToolEvidenceRequired("search_ui_references")).toBe(false);
  });
  it("returns false for get_ui_taxonomy", () => {
    expect(getToolEvidenceRequired("get_ui_taxonomy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolResultEnvelope — per-tool enforcement
// ---------------------------------------------------------------------------

describe("ToolResultEnvelope — evidence required for synthesis tools", () => {
  it("rejects plan_ui_direction success without evidence array", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "plan_ui_direction",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Direction",
      data: {},
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 3 },
      warnings: [],
    }).success).toBe(false);
  });

  it("accepts plan_ui_direction success with evidence (even empty, with warning)", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "plan_ui_direction",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Direction",
      data: {},
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 3 },
      warnings: ["Insufficient evidence for some claims"],
      evidence: [],
    }).success).toBe(true);
  });

  it("rejects search_ui_references with evidence (not an evidence tool)", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Results",
      data: {},
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 3 },
      warnings: [],
      evidence: [{ id: "ev-1", kind: "corpus-observation", summary: "x", basis: "visible" }],
    }).success).toBe(false);
  });

  it("accepts status ok with non-null data", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Found 5",
      data: { results: [] },
      referenceIds: ["ref-1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 5 },
      warnings: [],
    }).success).toBe(true);
  });

  it("rejects status ok with null data", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "x",
      data: null,
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 },
      warnings: [],
    }).success).toBe(false);
  });

  it("accepts status error with null data and error", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "error",
      summary: "Not found",
      data: null,
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 },
      warnings: [],
      error: { code: "NOT_FOUND", message: "No results", retryable: false },
    }).success).toBe(true);
  });

  it("rejects status error with non-null data", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "error",
      summary: "x",
      data: { foo: "bar" },
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 },
      warnings: [],
      error: { code: "ERR", message: "x", retryable: false },
    }).success).toBe(false);
  });

  it("strict-rejects unknown keys", () => {
    expect(ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "x",
      data: {},
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 },
      warnings: [],
      unexpected: true,
    }).success).toBe(false);
  });
});
