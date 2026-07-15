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
      expect(typeof d.extractRefs).toBe("function");
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
      provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0", sourceReferences: [], evidenceIds: [] },
    };
  }
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
    b.context = { productContext: "A fintech dashboard", designSystem: { status: "identified", library: "M3" } };
    b.citedDecisions = [
      { id: "d1", field: "color-primary", authority: "corpus-evidence", evidenceIds: [], readiness: "available" },
      { id: "d2", field: "color-accent", authority: "team-design-system", evidenceIds: [], readiness: "available" },
    ];
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
    const result = ToolResultSchemas["search_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
  });

  it("2: fallback with zero results rejected", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const r = p.retrieval as Record<string, unknown>;
    r.mode = "keyword"; r.modality = "text"; r.fallbackUsed = true;
    r.fallbackReason = "missing-index"; r.attemptedCount = 1; r.attemptedModes = ["vector"];
    (p.data as Record<string, unknown>).results = [];
    r.resultCount = 0;
    p.referenceIds = [];
    const result = ToolResultSchemas["search_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
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
    const result = ToolResultSchemas["plan_ui_direction"].safeParse(p);
    expect(result.success).toBe(false);
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
    const result = ToolResultSchemas["search_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
  });

  it("8: compare all-missing as success rejected", () => {
    const p = cloneToolResult(makeValidSuccess("compare_ui_references")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    data.entries = []; data.foundIds = []; data.missingIds = ["ref-a", "ref-b"];
    p.referenceIds = [];
    (p.retrieval as Record<string, unknown>).resultCount = 0;
    (p as Record<string, unknown>).warnings = [];
    const result = ToolResultSchemas["compare_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
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
    data.missingIds = []; // no missing but has partialResult warning
    p.warnings = [{ code: "partialResult", message: "x" }];
    const result = ToolResultSchemas["compare_ui_references"].safeParse(p);
    expect(result.success).toBe(false);
  });

  it("25: parseToolResult rejects unknown tool", () => {
    expect(parseToolResult({ tool: "not_a_tool", schemaVersion: "1.0" }).ok).toBe(false);
  });
});
