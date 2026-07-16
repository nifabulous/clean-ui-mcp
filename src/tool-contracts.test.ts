import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  TOOL_DESCRIPTORS, TOOL_CATALOG, ToolResultSchemas, ToolInputSchemas,
  parseToolResult, RetrievalState, Evidence, UiSpec, CreateUiSpecInput,
  ALLOWED_RETRIEVAL_STATES, CATALOG_DIGEST, LEGACY_TO_BETA_MAP,
  REMOVED_TOOL_NAMES,
} from "./tool-contracts.js";
import {
  VALID_TOOL_INPUTS, makeValidSuccess, makeValidError, cloneToolResult,
} from "./__fixtures__/tool-contract-fixtures.js";
import type { JsonObject } from "./__fixtures__/tool-contract-fixtures.js";

// ---------------------------------------------------------------------------
// Descriptor completeness
// ---------------------------------------------------------------------------

describe("TOOL_DESCRIPTORS", () => {
  it("has exactly 12 entries", () => { expect(TOOL_DESCRIPTORS).toHaveLength(12); });
  it("names match TOOL_CATALOG", () => {
    expect(TOOL_DESCRIPTORS.map(d => d.name)).toEqual([...TOOL_CATALOG]);
  });
  it("every descriptor has all required fields", () => {
    for (const d of TOOL_DESCRIPTORS) {
      expect(d.name).toBeTruthy();
      expect(d.rendererKey).toBeTruthy();
      expect(typeof d.hasEvidence).toBe("boolean");
      expect(d.inputSchema).toBeDefined();
      expect(d.dataSchema).toBeDefined();
      expect(d.retrieval.length).toBeGreaterThan(0);
      expect(typeof d.extractPrimaryIds).toBe("function");
      expect(typeof d.extractReferenceIds).toBe("function");
      expect(typeof d.countResults).toBe("function");
      expect(d.warningSchema).toBeDefined();
      expect(d.errorSchema).toBeDefined();
    }
  });
});

describe("derived exports", () => {
  it("CATALOG_DIGEST is independently recomputed correctly", () => {
    const expected = createHash("sha256").update(JSON.stringify(
      TOOL_DESCRIPTORS.map(d => ({
        name: d.name, rendererKey: d.rendererKey,
        hasEvidence: d.hasEvidence, legacyNames: [...d.legacyNames],
      })),
    )).digest("hex");
    expect(CATALOG_DIGEST).toBe(expected);
  });
  it("REMOVED_TOOL_NAMES has 13 entries", () => {
    expect(REMOVED_TOOL_NAMES).toHaveLength(13);
  });
  it("LEGACY_TO_BETA_MAP maps all removed names", () => {
    for (const name of REMOVED_TOOL_NAMES)
      expect(LEGACY_TO_BETA_MAP[name]).toBeDefined();
  });
  it("ToolResultSchemas has exactly TOOL_CATALOG keys", () => {
    expect(Object.keys(ToolResultSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
  it("ToolInputSchemas has exactly TOOL_CATALOG keys", () => {
    expect(Object.keys(ToolInputSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
});

// ---------------------------------------------------------------------------
// Retrieval matrix (per plan truth table)
// ---------------------------------------------------------------------------

describe("retrieval matrix follows plan", () => {
  it("none-only tools: taxonomy/get/compare/browse/research/spec", () => {
    const noneTools = ["get_ui_reference", "get_ui_taxonomy", "compare_ui_references",
      "browse_ui_patterns", "create_ui_spec", "research_ui_anti_patterns",
      "research_ui_palettes", "research_ui_techniques"];
    for (const t of noneTools) {
      expect(ALLOWED_RETRIEVAL_STATES[t].every(s => s.mode === "none")).toBe(true);
    }
  });
  it("similar: vector+text, structured-fallback; NO image, NO keyword", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["find_similar_ui_references"];
    expect(modes.some(s => s.mode === "vector" && s.modality === "text")).toBe(true);
    expect(modes.some(s => s.mode === "vector" && s.modality === "image")).toBe(false);
    expect(modes.some(s => s.mode === "keyword")).toBe(false);
  });
  it("critique: vector+image, structured-fallback; NO vector+text", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["critique_ui"];
    expect(modes.some(s => s.mode === "vector" && s.modality === "image")).toBe(true);
    expect(modes.some(s => s.mode === "vector" && s.modality === "text")).toBe(false);
  });
  it("plan: hybrid/keyword/structured-fallback; NO direct vector", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["plan_ui_direction"];
    expect(modes.some(s => s.mode === "hybrid")).toBe(true);
    expect(modes.some(s => s.mode === "vector")).toBe(false);
  });
});

describe("RetrievalState", () => {
  it("rejects structured-fallback without fallbackUsed", () => {
    expect(RetrievalState.safeParse({
      mode: "structured-fallback", modality: "metadata", resultCount: 0, fallbackUsed: false,
    }).success).toBe(false);
  });
  it("rejects attemptedModes containing current mode", () => {
    expect(RetrievalState.safeParse({
      mode: "keyword", modality: "text", resultCount: 3, fallbackUsed: true,
      fallbackReason: "missing-index", attemptedModes: ["keyword"],
    }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evidence discriminated lanes
// ---------------------------------------------------------------------------

describe("Evidence", () => {
  const ev = (kind: string, basis: string, extra: Record<string, unknown> = {}) =>
    Evidence.safeParse({ id: "e1", kind, summary: "x", basis, ...extra }).success;
  it("corpus-observation requires referenceId and visible/inferred basis", () => {
    expect(ev("corpus-observation", "visible")).toBe(false);
    expect(ev("corpus-observation", "visible", { referenceId: "r1" })).toBe(true);
    expect(ev("corpus-observation", "editorial", { referenceId: "r1" })).toBe(false);
  });
  it("machine-rule rejects visible and dom-grounded", () => {
    expect(ev("machine-rule", "editorial")).toBe(true);
    expect(ev("machine-rule", "visible")).toBe(false);
    expect(ev("machine-rule", "dom-grounded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseToolResult — thin dispatcher
// ---------------------------------------------------------------------------

describe("parseToolResult dispatcher", () => {
  it("rejects empty object", () => { expect(parseToolResult({}).ok).toBe(false); });
  it("rejects unknown tool", () => { expect(parseToolResult({ tool: "unknown" }).ok).toBe(false); });
  it("rejects missing tool", () => { expect(parseToolResult({ status: "ok" }).ok).toBe(false); });
});

// ---------------------------------------------------------------------------
// Valid fixtures for all 12 tools
// ---------------------------------------------------------------------------

describe.each(TOOL_CATALOG)("valid fixtures: %s", (tool) => {
  it("accepts its representative input", () => {
    expect(ToolInputSchemas[tool].safeParse(VALID_TOOL_INPUTS[tool as keyof typeof VALID_TOOL_INPUTS]).success).toBe(true);
  });

  it("accepts its representative success result", () => {
    const result = ToolResultSchemas[tool].safeParse(makeValidSuccess(tool as ToolName));
    expect(result.success).toBe(true);
  });

  it("accepts its representative application error when supported", () => {
    const fixture = makeValidError(tool as ToolName);
    if (fixture !== null) {
      expect(ToolResultSchemas[tool].safeParse(fixture).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-tool adversarial matrix via describe.each
// ---------------------------------------------------------------------------

describe.each(TOOL_DESCRIPTORS)("tool: $name", (desc) => {
  const schema = ToolResultSchemas[desc.name]!;

  it("error result requires resultCount:0", () => {
    const errorPayload = {
      tool: desc.name, schemaVersion: "1.0", status: "error" as const,
      summary: "test error", data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 5, fallbackUsed: false, attemptedCount: 0, attemptedModes: [] },
      warnings: [],
      error: { code: "NOT_FOUND", message: "x", retryable: false },
    };
    expect(schema.safeParse(errorPayload).success).toBe(false);
  });

  it("rejects unknown top-level field (.strict)", () => {
    // A minimal error envelope with an extra field
    const payload: Record<string, unknown> = {
      tool: desc.name, schemaVersion: "1.0", status: "error",
      summary: "x", data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false, attemptedCount: 0, attemptedModes: [] },
      warnings: [], error: { code: "NOT_FOUND", message: "x", retryable: false },
      unexpectedField: true,
    };
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it("rejects retrieval mode not in descriptor.retrieval", () => {
    // Pick a mode/modality pair that is NOT in this tool's allowed list
    const allowed = new Set(desc.retrieval.map(r => `${r.mode}/${r.modality}`));
    // Try all combinations until we find one not allowed
    let wrongMode = "hybrid", wrongModality = "image";
    for (const m of ["hybrid", "vector", "keyword", "structured-fallback", "none"]) {
      for (const mod of ["text", "image", "metadata", "none"]) {
        if (!allowed.has(`${m}/${mod}`)) { wrongMode = m; wrongModality = mod; break; }
      }
    }
    // Skip if every combination is somehow allowed (shouldn't happen)
    if (allowed.has(`${wrongMode}/${wrongModality}`)) return;
    // Use a valid error code for this tool
    const errorCodes = ["NOT_FOUND", "INDEX_UNAVAILABLE", "PROVIDER_ERROR", "INVALID_INPUT"];
    const validCode = errorCodes.find(c => {
      const testParse = schema.safeParse({
        tool: desc.name, schemaVersion: "1.0", status: "error",
        summary: "x", data: null, referenceIds: [],
        retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false, attemptedCount: 0, attemptedModes: [] },
        warnings: [], error: { code: c, message: "x", retryable: c === "NOT_FOUND" || c === "INVALID_INPUT" ? false : true },
      });
      // Check if this error code passes (meaning it's valid for this tool)
      return testParse.success || testParse.error.issues.every(i => !i.message.includes("code"));
    }) ?? "NOT_FOUND";
    const retryable = validCode === "NOT_FOUND" || validCode === "INVALID_INPUT" ? false : true;
    expect(schema.safeParse({
      tool: desc.name, schemaVersion: "1.0", status: "error",
      summary: "x", data: null, referenceIds: [],
      retrieval: { mode: wrongMode, modality: wrongModality, resultCount: 0, fallbackUsed: false, attemptedCount: 0, attemptedModes: [] },
      warnings: [], error: { code: validCode, message: "x", retryable },
    }).success).toBe(false);
  });

  it("non-evidence tool rejects evidence property", () => {
    if (desc.hasEvidence) return; // skip for evidence tools
    const payload = cloneToolResult(makeValidSuccess(desc.name));
    (payload as Record<string, unknown>).evidence = [
      { id: "e1", kind: "corpus-observation", referenceId: "ref-a", summary: "x", basis: "visible" },
    ];
    const result = schema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "evidence")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// UiSpec
// ---------------------------------------------------------------------------

function validUiSpec(): Record<string, unknown> {
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
    unavailableDecisions: [{ field: "motion", reason: "no DOM evidence" }],
    acceptanceCriteria: [{
      id: "ac1", subject: "contrast", assertion: "meets-contrast",
      expectedOutcome: "4.5:1", verifier: "axe", priority: "must", evidenceIds: [],
    }],
    citedReferences: [], citedDecisions: [],
    authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
    provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0", sourceReferences: [], evidenceIds: [] },
  };
}

describe("UiSpec", () => {
  const valid = validUiSpec;
  it("accepts complete spec", () => {
    // The valid fixture has motionGuidance.evidenceUnavailable: true, so it needs a motion unavailableDecision
    const b = valid();
    b.unavailableDecisions = [{ field: "motion", reason: "no DOM evidence" }];
    expect(UiSpec.safeParse(b).success).toBe(true);
  });
  it("accepts null tokens (sparse)", () => {
    const b = valid();
    b.colorTokens = null;
    b.colorTokenAuthority = "editorial";
    b.unavailableDecisions = [
      { field: "colorTokens", reason: "no corpus evidence" },
      { field: "motion", reason: "no DOM evidence" },
    ];
    expect(UiSpec.safeParse(b).success).toBe(true);
  });
  it("manual verifier requires manualSteps", () => {
    const b = valid();
    b.acceptanceCriteria = [{ id: "ac1", subject: "x", assertion: "exists", expectedOutcome: "y", verifier: "manual", priority: "must", evidenceIds: [] }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("playwright requires selector", () => {
    const b = valid();
    b.acceptanceCriteria = [{ id: "ac1", subject: "x", assertion: "exists", expectedOutcome: "y", verifier: "playwright", priority: "must", evidenceIds: [] }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("static-analysis requires command", () => {
    const b = valid();
    b.acceptanceCriteria = [{ id: "ac1", subject: "x", assertion: "exists", expectedOutcome: "y", verifier: "static-analysis", priority: "must", evidenceIds: [] }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("rejects priority 'could'", () => {
    const b = valid();
    (b.acceptanceCriteria as Array<Record<string, unknown>>)[0].priority = "could";
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("rejects mixed authority without >1 distinct non-editorial child lanes", () => {
    const b = valid();
    b.colorTokenAuthority = "mixed";
    b.citedDecisions = [{ id: "d1", field: "color", authority: "corpus-evidence", evidenceIds: [], readiness: "available" }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("accepts mixed authority with >1 distinct non-editorial child lanes", () => {
    const b = valid();
    b.colorTokenAuthority = "mixed";
    b.unavailableDecisions = [{ field: "motion", reason: "no DOM evidence" }];
    b.context = { productContext: "A fintech dashboard", designSystem: { status: "identified", library: "M3" }, constraints: ["WCAG AA"] };
    b.citedDecisions = [
      { id: "d1", field: "color-primary", authority: "corpus-evidence", evidenceIds: ["ev-corpus"], readiness: "available" },
      { id: "d2", field: "color-accent", authority: "team-design-system", evidenceIds: [], readiness: "available" },
    ];
    b.authorityLanes = { corpusEvidence: ["ev-corpus"], machineRules: [], editorialGuidance: [] };
    expect(UiSpec.safeParse(b).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CreateUiSpecInput
// ---------------------------------------------------------------------------

describe("CreateUiSpecInput", () => {
  it("requires productContext min 8", () => {
    expect(CreateUiSpecInput.safeParse({ productContext: "short" }).success).toBe(false);
    expect(CreateUiSpecInput.safeParse({ productContext: "a dashboard" }).success).toBe(true);
  });
  it("enforces unique referenceIds", () => {
    expect(CreateUiSpecInput.safeParse({ productContext: "dashboard", referenceIds: ["r1", "r1"] }).success).toBe(false);
  });
  it("allows 0 references", () => {
    expect(CreateUiSpecInput.safeParse({ productContext: "a dashboard" }).success).toBe(true);
  });
  it("accepts designSystem as object", () => {
    expect(CreateUiSpecInput.safeParse({
      productContext: "a dashboard",
      designSystem: { status: "identified", registry: "Material Theme Builder", library: "M3" },
    }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 8: 25 adversarial probes — each mutates ONE property from a valid fixture
// and asserts rejection at the intended issue path.
// ---------------------------------------------------------------------------

describe("adversarial probe matrix", () => {
  // Helper: parse and assert failure at a specific top-level path
  function assertRejectsAt(payload: unknown, pathSegment: PropertyKey) {
    const result = ToolResultSchemas[(payload as Record<string, unknown>).tool as string]?.safeParse(payload);
    expect(result?.success).toBe(false);
    if (!result?.success) {
      expect(result.error.issues.some(i => i.path[0] === pathSegment)).toBe(true);
    }
  }

  // --- Retrieval metadata probes (1-5) ---

  it("1: wrong per-tool fallback reason rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const r = p.retrieval as Record<string, unknown>;
    r.mode = "keyword"; r.modality = "text"; r.fallbackUsed = true;
    r.fallbackReason = "no-image-evidence"; // only valid for critique
    r.attemptedCount = 1; r.attemptedModes = ["vector"];
    (p.retrieval as Record<string, unknown>).resultCount = 1;
    assertRejectsAt(p, "retrieval");
  });

  it("2: fallback with zero results rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const r = p.retrieval as Record<string, unknown>;
    r.mode = "keyword"; r.modality = "text"; r.fallbackUsed = true;
    r.fallbackReason = "missing-index"; r.attemptedCount = 1; r.attemptedModes = ["vector"];
    (p.data as Record<string, unknown>).results = [];
    r.resultCount = 0;
    p.referenceIds = [];
    assertRejectsAt(p, "retrieval");
  });

  it("3: terminal error records attempted paths without fallback (accepted)", () => {
    const p = makeValidError("search_ui_references");
    if (!p) return;
    const r = p.retrieval as Record<string, unknown>;
    r.attemptedCount = 1; r.attemptedModes = ["vector"];
    const result = ToolResultSchemas["search_ui_references"].safeParse(p);
    expect(result.success).toBe(true);
  });

  it("4: forbidden attempted mode rejected", () => {
    const p = cloneToolResult(makeValidSuccess("plan_ui_direction")) as Record<string, unknown>;
    const r = p.retrieval as Record<string, unknown>;
    r.mode = "keyword"; r.modality = "text"; r.fallbackUsed = true;
    r.fallbackReason = "missing-index"; r.attemptedCount = 1; r.attemptedModes = ["vector"]; // plan doesn't allow direct vector
    assertRejectsAt(p, "retrieval");
  });

  it("5: error claims fallback rejected", () => {
    const p = makeValidError("plan_ui_direction");
    if (!p) return;
    const r = p.retrieval as Record<string, unknown>;
    r.fallbackUsed = true; r.fallbackReason = "missing-index";
    r.attemptedCount = 1; r.attemptedModes = ["hybrid"];
    const result = ToolResultSchemas["plan_ui_direction"].safeParse(p);
    expect(result.success).toBe(false);
  });

  // --- Duplicate and partial-result probes (6-8) ---

  it("6: repeated aggregation source accepted (not duplicate)", () => {
    const p = cloneToolResult(makeValidSuccess("research_ui_anti_patterns")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    data.results = [
      { text: "Avoid A", sourceIds: ["ref-a"], count: 1 },
      { text: "Avoid B", sourceIds: ["ref-a"], count: 1 },
    ];
    // resultCount must match the new 2-row data
    (p.retrieval as Record<string, unknown>).resultCount = 2;
    // referenceIds stays ["ref-a"] — one reference, two rows. Must pass.
    const result = ToolResultSchemas["research_ui_anti_patterns"].safeParse(p);
    expect(result.success).toBe(true);
  });

  it("7: duplicate primary search row rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    const results = data.results as Array<Record<string, unknown>>;
    results.push({ ...results[0] }); // duplicate id "ref-a"
    assertRejectsAt(p, "data");
  });

  it("8: compare all-missing as success rejected", () => {
    const p = cloneToolResult(makeValidSuccess("compare_ui_references")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    data.foundIds = []; // ONE mutation: empty foundIds
    const result = ToolResultSchemas["compare_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "data" || i.path[0] === "foundIds")).toBe(true);
    }
  });

  // --- Evidence graph probes (9-13) ---

  it("9: ghost plan evidence rejected", () => {
    const p = cloneToolResult(makeValidSuccess("plan_ui_direction")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    const decisions = data.structuredDecisions as Array<Record<string, unknown>>;
    decisions[0]!.evidenceIds = ["evidence-ghost"];
    assertRejectsAt(p, "data");
  });

  it("10: ghost UiSpec evidence self-authorized through provenance rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    // Add ghost to provenance — must NOT authorize it elsewhere
    const prov = data.provenance as Record<string, unknown>;
    (prov.evidenceIds as string[]).push("evidence-ghost");
    // Use ghost in an acceptance criterion
    const ac = data.acceptanceCriteria as Array<Record<string, unknown>>;
    ac[0]!.evidenceIds = ["evidence-ghost"];
    assertRejectsAt(p, "data");
  });

  it("11: one-way provenance omission rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    const prov = data.provenance as Record<string, unknown>;
    // Remove an evidence ID from provenance that exists in envelope
    prov.evidenceIds = [];
    assertRejectsAt(p, "data");
  });

  it("12: ghost critique evidence in recommendations rejected", () => {
    const p = cloneToolResult(makeValidSuccess("critique_ui")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    const recs = data.recommendations as Array<Record<string, unknown>>;
    recs[0]!.evidence = ["evidence-ghost"];
    assertRejectsAt(p, "data");
  });

  it("13: non-evidence tool carrying evidence:[] rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    p.evidence = [];
    assertRejectsAt(p, "evidence");
  });

  // --- Envelope integrity probes (14-18) ---

  it("14: error with non-empty referenceIds rejected", () => {
    const p = makeValidError("get_ui_reference");
    if (!p) return;
    p.referenceIds = ["ghost"];
    assertRejectsAt(p, "referenceIds");
  });

  it("15: error with resultCount > 0 rejected", () => {
    const p = makeValidError("search_ui_references");
    if (!p) return;
    (p.retrieval as Record<string, unknown>).resultCount = 5;
    assertRejectsAt(p, "retrieval");
  });

  it("16: mismatched resultCount rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    (p.retrieval as Record<string, unknown>).resultCount = 99;
    assertRejectsAt(p, "retrieval");
  });

  it("17: dangling referenceIds (extra) rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    p.referenceIds = ["ref-a", "ghost"];
    assertRejectsAt(p, "referenceIds");
  });

  it("18: empty evidence without insufficiency warning rejected", () => {
    const p = cloneToolResult(makeValidSuccess("plan_ui_direction")) as Record<string, unknown>;
    (p.evidence as unknown[]) = [];
    p.warnings = [];
    assertRejectsAt(p, "warnings");
  });

  // --- QA-identified missing probes (19-25) ---

  it("19: wrong evidence kind for tool rejected", () => {
    const p = cloneToolResult(makeValidSuccess("plan_ui_direction")) as Record<string, unknown>;
    const ev = p.evidence as Array<Record<string, unknown>>;
    ev[0]!.kind = "screen-observation"; // plan can't emit screen evidence
    delete ev[0]!.referenceId;
    assertRejectsAt(p, "evidence");
  });

  it("20: evidence referenceId not in referenceIds rejected", () => {
    const p = cloneToolResult(makeValidSuccess("plan_ui_direction")) as Record<string, unknown>;
    const ev = p.evidence as Array<Record<string, unknown>>;
    ev[0]!.referenceId = "ref-ghost";
    assertRejectsAt(p, "evidence");
  });

  it("21: unknown top-level field rejected (.strict)", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    p.unexpectedField = true;
    const result = ToolResultSchemas["search_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
  });

  it("22: duplicate referenceIds rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    p.referenceIds = ["ref-a", "ref-a"];
    assertRejectsAt(p, "referenceIds");
  });

  it("23: duplicate evidence IDs rejected", () => {
    const p = cloneToolResult(makeValidSuccess("plan_ui_direction")) as Record<string, unknown>;
    const ev = p.evidence as Array<Record<string, unknown>>;
    ev.push({ ...ev[0] }); // duplicate id
    assertRejectsAt(p, "evidence");
  });

  it("24: compare partialResult warning without missingIds rejected", () => {
    const p = cloneToolResult(makeValidSuccess("compare_ui_references")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    data.missingIds = []; // ONE mutation: remove missingIds but keep partialResult warning
    assertRejectsAt(p, "warnings");
  });

  it("25: parseToolResult rejects unknown tool", () => {
    expect(parseToolResult({ tool: "not_a_tool", schemaVersion: "1.0" }).ok).toBe(false);
  });

  // --- Bypass probes (26-40): one-property mutations for every reproduced bypass ---

  it("26: ghost authorityLanes evidence rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    const lanes = data.authorityLanes as Record<string, unknown>;
    (lanes.corpusEvidence as string[]).push("evidence-ghost");
    assertRejectsAt(p, "data");
  });

  it("27: ghost technique sourceId rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    (data.techniques as Array<Record<string, unknown>>)[0]!.sourceIds = ["ref-ghost"];
    assertRejectsAt(p, "data");
  });

  it("28: ghost antiPattern sourceId rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    (data.antiPatterns as Array<Record<string, unknown>>).push({ text: "bad", sourceIds: ["ref-ghost"] });
    assertRejectsAt(p, "data");
  });

  it("29: duplicate citedReferences rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    data.citedReferences = ["ref-a", "ref-a"];
    // provenance.sourceReferences must also match — set them too
    (data.provenance as Record<string, unknown>).sourceReferences = ["ref-a", "ref-a"];
    assertRejectsAt(p, "data");
  });

  it("30: duplicate provenance evidenceIds rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    (data.provenance as Record<string, unknown>).evidenceIds = ["evidence-corpus-a", "evidence-corpus-a"];
    assertRejectsAt(p, "data");
  });

  it("31: team-design-system authority without identified design system rejected", () => {
    const b = validUiSpec();
    b.colorTokenAuthority = "team-design-system"; // ONE mutation
    const result = UiSpec.safeParse(b);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "context" || i.path[0] === "citedDecisions")).toBe(true);
    }
  });

  it("32: motion evidence unavailable without exact unavailableDecision rejected", () => {
    const b = validUiSpec();
    b.unavailableDecisions = []; // ONE mutation: remove the motion unavailableDecision
    const result = UiSpec.safeParse(b);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "unavailableDecisions")).toBe(true);
    }
  });

  it("33: contradictory unavailableDecision for available tokens rejected", () => {
    const b = validUiSpec();
    // ONE mutation: add a colorTokens unavailableDecision when tokens are present
    (b.unavailableDecisions as Array<Record<string, unknown>>).push({ field: "colorTokens", reason: "should not be here" });
    const result = UiSpec.safeParse(b);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "unavailableDecisions")).toBe(true);
    }
  });

  it("34: substring-based unavailable field (not-color-really) rejected", () => {
    const b = validUiSpec();
    b.colorTokens = null; // mutation 1 (required to set up the test)
    b.colorTokenAuthority = "editorial"; // mutation 2 (required by null-tokens rule)
    (b.unavailableDecisions as Array<Record<string, unknown>>)[0]!.field = "not-color-really"; // THE mutation under test
    const result = UiSpec.safeParse(b);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "unavailableDecisions")).toBe(true);
    }
  });

  it("35: critique data.retrievalMode disagrees with envelope rejected", () => {
    const p = cloneToolResult(makeValidSuccess("critique_ui")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    data.retrievalMode = "keyword"; // envelope says "none"
    assertRejectsAt(p, "data");
  });

  it("36: duplicate appliedReferences rejected", () => {
    const p = cloneToolResult(makeValidSuccess("critique_ui")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    const refs = data.appliedReferences as Array<Record<string, unknown>>;
    refs.push({ ...refs[0] }); // duplicate id
    assertRejectsAt(p, "data");
  });

  it("37: critique motion.reference ref:ghost rejected", () => {
    const p = cloneToolResult(makeValidSuccess("critique_ui")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    (data.motion as Array<Record<string, unknown>>).push({
      basis: "editorial", evidence: [], note: "test", reference: "ref:ghost",
    });
    assertRejectsAt(p, "data");
  });

  it("38: default search limit is 5", () => {
    expect(ToolInputSchemas["search_ui_references"].parse({}).limit).toBe(5);
  });

  it("39: default plan qualityTier is exceptional and count is 3", () => {
    const parsed = ToolInputSchemas["plan_ui_direction"].parse({ productContext: "A dashboard" });
    expect(parsed).toMatchObject({ qualityTier: "exceptional", count: 3 });
  });

  it("40: default techniques limit is 15", () => {
    expect(ToolInputSchemas["research_ui_techniques"].parse({}).limit).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// R1: string min-length must run AFTER trim (whitespace-only inputs must fail)
// ---------------------------------------------------------------------------

describe("R1: trim-before-min ordering", () => {
  it("plan_ui_direction rejects whitespace-only productContext (8 spaces)", () => {
    // min(8) must run on the TRIMMED value, so 8 spaces → "" fails the check.
    const r = ToolInputSchemas["plan_ui_direction"].safeParse({ productContext: "        " });
    expect(r.success).toBe(false);
  });

  it("get_ui_reference rejects whitespace-only id (min 1)", () => {
    const r = ToolInputSchemas["get_ui_reference"].safeParse({ id: "   " });
    expect(r.success).toBe(false);
  });

  it("valid productContext passes and is trimmed", () => {
    const r = ToolInputSchemas["plan_ui_direction"].safeParse({ productContext: "  analytics  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.productContext).toBe("analytics");
  });

  it("valid id passes and is trimmed", () => {
    const r = ToolInputSchemas["get_ui_reference"].safeParse({ id: "  ref-a  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.id).toBe("ref-a");
  });

  it("productContext at exact min length (8 chars) passes", () => {
    const r = ToolInputSchemas["plan_ui_direction"].safeParse({ productContext: "x".repeat(8) });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2: community-edition fallback reason for similar/plan/critique
// Per the plan Task 2 Step 2 table, structured-fallback for similar, plan, and
// critique must accept "community-edition" (search already did; critique keeps
// "no-image-evidence" too). An undocumented reason must still be rejected.
// ---------------------------------------------------------------------------

describe("R2: community-edition structured-fallback reason", () => {
  // Build a valid structured-fallback success with community-edition for each tool.
  const tools = ["find_similar_ui_references", "plan_ui_direction", "critique_ui"] as const;
  for (const tool of tools) {
    it(`${tool}: accepts structured-fallback + community-edition`, () => {
      const payload = cloneToolResult(makeValidSuccess(tool));
      payload.retrieval = {
        mode: "structured-fallback",
        modality: "metadata",
        resultCount: payload.retrieval.resultCount,
        fallbackUsed: true,
        attemptedCount: 1,
        fallbackReason: "community-edition",
        attemptedModes: tool === "plan_ui_direction" ? ["keyword"] : ["vector"],
      };
      // critique carries legacy nested retrieval fields that must agree with the envelope.
      if (tool === "critique_ui") {
        (payload.data as { retrievalMode?: string }).retrievalMode = "structured-fallback";
        (payload.data as { fallbackUsed?: boolean }).fallbackUsed = true;
      }
      const r = ToolResultSchemas[tool].safeParse(payload);
      expect(r.success).toBe(true);
    });
  }

  it("similar: rejects an undocumented fallback reason", () => {
    const payload = cloneToolResult(makeValidSuccess("find_similar_ui_references"));
    payload.retrieval = {
      mode: "structured-fallback",
      modality: "metadata",
      resultCount: payload.retrieval.resultCount,
      fallbackUsed: true,
      attemptedCount: 1,
      fallbackReason: "totally-fabricated-reason",
      attemptedModes: ["vector"],
    };
    const r = ToolResultSchemas.find_similar_ui_references.safeParse(payload);
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3: descriptor-driven primary/reference IDs and closed nested evidence.
// Bug 1: primary vs reference ID separation was hard-coded and incomplete
//   (browse patternType is a primary key but wasn't in the list; compare's
//   foundIds were mis-classified as primary).
// Bug 2: nested evidence lists had no within-list dedup.
// ---------------------------------------------------------------------------

describe("R3: browse dup patternType fails (primary key)", () => {
  it("rejects two pattern groups with the SAME patternType but different exemplar IDs", () => {
    const payload = cloneToolResult(makeValidSuccess("browse_ui_patterns"));
    const g = (payload.data as { patterns: object[] }).patterns[0] as Record<string, unknown>;
    const g2 = { ...g, exemplar: { ...(g.exemplar as Record<string, unknown>), id: "ref-zzz" } };
    (payload.data as { patterns: unknown[] }).patterns = [g, g2];
    payload.retrieval.resultCount = 2;
    payload.referenceIds = ["ref-a", "ref-zzz"];
    const r = ToolResultSchemas.browse_ui_patterns.safeParse(payload);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /duplicate primary/i.test(i.message))).toBe(true);
    }
  });
});

describe("R3: plan dup structuredDecisions evidenceIds fails", () => {
  it("rejects structuredDecisions[0].evidenceIds = [id, id] (same id twice)", () => {
    const payload = cloneToolResult(makeValidSuccess("plan_ui_direction"));
    const sds = (payload.data as { structuredDecisions: Array<{ evidenceIds: string[] }> }).structuredDecisions;
    sds[0].evidenceIds = ["evidence-corpus-a", "evidence-corpus-a"];
    const r = ToolResultSchemas.plan_ui_direction.safeParse(payload);
    expect(r.success).toBe(false);
  });
});

describe("R3: spec dup provenance.sourceReferences fails", () => {
  it("rejects provenance.sourceReferences = [ref, ref] while citedReferences stays valid", () => {
    const payload = cloneToolResult(makeValidSuccess("create_ui_spec"));
    const data = payload.data as {
      provenance: { sourceReferences: string[] };
      citedReferences: string[];
    };
    // Duplicate ONLY provenance.sourceReferences; keep citedReferences valid.
    // The Set-based sameSet compare collapses the dup, so the bug accepted this.
    data.provenance.sourceReferences = ["ref-a", "ref-a"];
    // citedReferences remains ["ref-a"] (the valid fixture value).
    const r = ToolResultSchemas.create_ui_spec.safeParse(payload);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /sourceReferences must be unique/i.test(i.message))).toBe(true);
    }
  });
});

describe("R3 anti-regression: shared referenced ID across aggregation rows passes", () => {
  it("research_ui_anti_patterns with two rows BOTH citing sourceIds: [\"ref-a\"] is valid", () => {
    const payload = cloneToolResult(makeValidSuccess("research_ui_anti_patterns"));
    (payload.data as { results: Array<{ text: string; sourceIds: string[]; count: number }> }).results = [
      { text: "Avoid centering everything", sourceIds: ["ref-a"], count: 2 },
      { text: "Avoid low contrast", sourceIds: ["ref-a"], count: 1 },
    ];
    payload.retrieval.resultCount = 2;
    payload.referenceIds = ["ref-a"];
    const r = ToolResultSchemas.research_ui_anti_patterns.safeParse(payload);
    expect(r.success).toBe(true);
  });
});

describe("R3 anti-regression: search dup primary row still fails", () => {
  it("rejects search results = [r, r] (same id twice)", () => {
    const payload = cloneToolResult(makeValidSuccess("search_ui_references"));
    const results = (payload.data as { results: object[] }).results;
    (payload.data as { results: unknown[] }).results = [results[0], results[0]];
    payload.retrieval.resultCount = 2;
    const r = ToolResultSchemas.search_ui_references.safeParse(payload);
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R4: evidence-kind authority prerequisites.
// Bug: the create_ui_spec authority prerequisite checks verified ONLY lane
// membership (authorityLanes.corpusEvidence / editorialGuidance). A lying lane
// assignment — e.g. an editorial-guidance-kind evidence item placed in the
// corpusEvidence lane and cited by a corpus-evidence decision — was accepted.
// The fix verifies the actual envelope evidence kind backing each citedDecision.
// ---------------------------------------------------------------------------

describe("R4: evidence-kind authority prerequisites", () => {
  // Helper: add an editorial-guidance evidence item to the create_ui_spec fixture.
  function addEditorialEvidence(p: ReturnType<typeof cloneToolResult<JsonObject>>) {
    const env = p as unknown as {
      evidence: Array<Record<string, unknown>>;
      data: {
        provenance: { evidenceIds: string[] };
        citedDecisions: Array<Record<string, unknown>>;
        authorityLanes: { corpusEvidence: string[]; machineRules: string[]; editorialGuidance: string[] };
      };
    };
    env.evidence.push({
      id: "evidence-edit-lie", kind: "editorial-guidance",
      summary: "Editorial opinion about accent color", basis: "editorial",
    });
    // provenance.evidenceIds must exactly match envelope evidence IDs
    env.data.provenance.evidenceIds = ["evidence-corpus-a", "evidence-edit-lie"];
    return env;
  }

  it("rejects corpus-evidence decision backed only by editorial-guidance-kind evidence (lying lane)", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as unknown as ReturnType<typeof cloneToolResult<JsonObject>>;
    const env = addEditorialEvidence(p);
    // corpus-evidence decision backed ONLY by the editorial-guidance evidence
    env.data.citedDecisions = [{
      id: "cd-lie", field: "color-accent", authority: "corpus-evidence",
      evidenceIds: ["evidence-edit-lie"], readiness: "available", sourceId: "ref-a",
    }];
    // Lying partition: editorial evidence placed in the corpus lane
    env.data.authorityLanes = {
      corpusEvidence: ["evidence-corpus-a", "evidence-edit-lie"],
      machineRules: [], editorialGuidance: [],
    };
    // colorTokenAuthority is corpus-evidence in the fixture; the valid corpus decision
    // (cd1) was removed above, so add a corpus-observation-backed color decision to
    // keep colorTokenAuthority valid and isolate the failure to cd-lie.
    env.data.citedDecisions.unshift({
      id: "cd-color", field: "color-primary", authority: "corpus-evidence",
      evidenceIds: ["evidence-corpus-a"], readiness: "available", sourceId: "ref-a",
    });
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /cd-lie.*corpus-evidence/i.test(i.message) || /authority.*evidence.*kind/i.test(i.message))).toBe(true);
    }
  });

  it("anti-regression: corpus-evidence decision backed by corpus-observation-kind evidence passes", () => {
    // The valid fixture already models this (cd1 cites evidence-corpus-a, kind corpus-observation).
    const p = cloneToolResult(makeValidSuccess("create_ui_spec"));
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(true);
  });

  it("rejects editorial decision backed only by corpus-observation-kind evidence", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as unknown as ReturnType<typeof cloneToolResult<JsonObject>>;
    const data = (p as unknown as { data: {
      citedDecisions: Array<Record<string, unknown>>;
      authorityLanes: { corpusEvidence: string[]; machineRules: string[]; editorialGuidance: string[] };
    } }).data;
    // editorial decision backed ONLY by the corpus-observation evidence
    data.citedDecisions = [{
      id: "cd-bad-edit", field: "color-accent", authority: "editorial",
      evidenceIds: ["evidence-corpus-a"], readiness: "available",
    }];
    // Place the corpus-observation evidence in the editorial lane (lying partition)
    data.authorityLanes = {
      corpusEvidence: [], machineRules: [],
      editorialGuidance: ["evidence-corpus-a"],
    };
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /cd-bad-edit.*editorial/i.test(i.message) || /authority.*evidence.*kind/i.test(i.message))).toBe(true);
    }
  });

  it("rejects kind/lane disagreement: corpus-observation evidence in editorial lane cited by corpus-evidence decision", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as unknown as ReturnType<typeof cloneToolResult<JsonObject>>;
    const data = (p as unknown as { data: {
      citedDecisions: Array<Record<string, unknown>>;
      authorityLanes: { corpusEvidence: string[]; machineRules: string[]; editorialGuidance: string[] };
    } }).data;
    // corpus-evidence decision backed by corpus-observation evidence (kind is correct)
    data.citedDecisions = [{
      id: "cd-disagree", field: "color-primary", authority: "corpus-evidence",
      evidenceIds: ["evidence-corpus-a"], readiness: "available", sourceId: "ref-a",
    }];
    // BUT place that corpus-observation evidence in the WRONG (editorial) lane
    data.authorityLanes = {
      corpusEvidence: [], machineRules: [],
      editorialGuidance: ["evidence-corpus-a"],
    };
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R4 Part C: authorityConflict warning for same-field conflicting authorities.
// Two citedDecisions for the SAME exact field but DIFFERENT authority lanes is a
// conflict; the artifact must declare an authorityConflict warning. If absent,
// the spec is rejected. If present, it is accepted.
// ---------------------------------------------------------------------------

describe("R4 Part C: authorityConflict warning", () => {
  // Build a spec with two decisions for field "color-accent" with conflicting
  // authorities, each backed by the correct evidence kind/lane.
  function conflictingSpec(): JsonObject {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as JsonObject;
    const env = p as unknown as {
      evidence: Array<Record<string, unknown>>;
      data: {
        provenance: { evidenceIds: string[] };
        citedDecisions: Array<Record<string, unknown>>;
        authorityLanes: { corpusEvidence: string[]; machineRules: string[]; editorialGuidance: string[] };
      };
    };
    // Add an editorial-guidance evidence item alongside the existing corpus-observation one.
    env.evidence.push({
      id: "evidence-edit", kind: "editorial-guidance",
      summary: "Editorial accent guidance", basis: "editorial",
    });
    env.data.provenance.evidenceIds = ["evidence-corpus-a", "evidence-edit"];
    // Two decisions for the SAME exact field with different authorities.
    env.data.citedDecisions = [
      { id: "cd-corpus", field: "color-accent", authority: "corpus-evidence", evidenceIds: ["evidence-corpus-a"], readiness: "available", sourceId: "ref-a" },
      { id: "cd-edit", field: "color-accent", authority: "editorial", evidenceIds: ["evidence-edit"], readiness: "available" },
    ];
    env.data.authorityLanes = {
      corpusEvidence: ["evidence-corpus-a"], machineRules: [],
      editorialGuidance: ["evidence-edit"],
    };
    return p;
  }

  it("rejects same-field conflicting authorities without authorityConflict warning", () => {
    const p = conflictingSpec();
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /authorityConflict/i.test(i.message))).toBe(true);
    }
  });

  it("accepts same-field conflicting authorities WITH authorityConflict warning", () => {
    const p = conflictingSpec();
    (p as unknown as { warnings: Array<Record<string, unknown>> }).warnings.push({
      code: "authorityConflict", message: "Conflicting authority lanes for field color-accent",
    });
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(true);
  });

  it("rejects authorityConflict warning without an actual conflict (no false conflicts)", () => {
    // The valid fixture has a single color-primary decision (no conflict), so
    // emitting authorityConflict should be rejected.
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as JsonObject;
    (p as unknown as { warnings: Array<Record<string, unknown>> }).warnings.push({
      code: "authorityConflict", message: "bogus conflict",
    });
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /authorityConflict/i.test(i.message))).toBe(true);
    }
  });
});
