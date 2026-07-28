import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TOOL_DESCRIPTORS, TOOL_CATALOG, ToolResultSchemas, ToolInputSchemas,
  parseToolResult, RetrievalState, Evidence, UiSpec, CreateUiSpecInput,
  ALLOWED_RETRIEVAL_STATES, CATALOG_DIGEST, LEGACY_TO_BETA_MAP,
  REMOVED_TOOL_NAMES, findUnsafeCreateUiSpecLeaves,
} from "./tool-contracts.js";
import {
  VALID_TOOL_INPUTS, makeValidSuccess, makeValidError, cloneToolResult,
  makeCreateUiSpecAutomatic, makeCreateUiSpecZeroResultFallback,
  makeCreateUiSpecExplicitReferences, SAFE_PUBLIC_REFERENCE,
} from "./__fixtures__/tool-contract-fixtures.js";
import type { JsonObject } from "./__fixtures__/tool-contract-fixtures.js";
import { MotionIntentSchema, WebTargetId } from "./design-target-contracts.js";
import { CreateUiSpecRequestSchema } from "./create-ui-spec-contracts.js";

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
  it("none-only tools: taxonomy/get/compare/browse/research", () => {
    const noneTools = ["get_ui_reference", "get_ui_taxonomy", "compare_ui_references",
      "browse_ui_patterns", "research_ui_anti_patterns",
      "research_ui_palettes", "research_ui_techniques"];
    for (const t of noneTools) {
      expect(ALLOWED_RETRIEVAL_STATES[t].every(s => s.mode === "none")).toBe(true);
    }
  });
  it("spec: exactly hybrid/text, keyword/metadata, structured-fallback/metadata, none/none", () => {
    expect(ALLOWED_RETRIEVAL_STATES["create_ui_spec"].map(s => `${s.mode}/${s.modality}`)).toEqual([
      "hybrid/text", "keyword/metadata", "structured-fallback/metadata", "none/none",
    ]);
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

  it("2b: fallback with zero results ACCEPTED when reason is no-results (honest empty-set state)", () => {
    // Counterpart to test 2: a zero-result fallback with reason "no-results" is
    // the truthful semantic for "the query succeeded and returned an empty set"
    // (e.g. C3 keyword-only retrieval that found no matches). It must pass the
    // shared validator, unlike a zero-result fallback with a recovery reason
    // (missing-index etc.) which is still a failed recovery.
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const r = p.retrieval as Record<string, unknown>;
    r.mode = "structured-fallback"; r.modality = "metadata"; r.fallbackUsed = true;
    r.fallbackReason = "no-results"; r.attemptedCount = 1; r.attemptedModes = ["keyword"];
    (p.data as Record<string, unknown>).results = [];
    r.resultCount = 0;
    p.referenceIds = [];
    const result = ToolResultSchemas["search_ui_references"].safeParse(p);
    expect(result.success).toBe(true);
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
    data.citedReferences = [SAFE_PUBLIC_REFERENCE, SAFE_PUBLIC_REFERENCE];
    // provenance.sourceReferences must also match — set them too
    (data.provenance as Record<string, unknown>).sourceReferences = [SAFE_PUBLIC_REFERENCE, SAFE_PUBLIC_REFERENCE];
    assertRejectsAt(p, "data");
  });

  it("30: duplicate provenance evidenceIds rejected", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    (data.provenance as Record<string, unknown>).evidenceIds = ["evidence-1", "evidence-1"];
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
    data.provenance.sourceReferences = [SAFE_PUBLIC_REFERENCE, SAFE_PUBLIC_REFERENCE];
    // citedReferences remains [SAFE_PUBLIC_REFERENCE] (the valid fixture value).
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
  // Helper: add an editorial-grounding evidence item to the create_ui_spec fixture.
  function addEditorialGroundingEvidence(p: ReturnType<typeof cloneToolResult<JsonObject>>) {
    const env = p as unknown as {
      evidence: Array<Record<string, unknown>>;
      data: {
        provenance: { evidenceIds: string[] };
        citedDecisions: Array<Record<string, unknown>>;
        authorityLanes: { corpusEvidence: string[]; machineRules: string[]; editorialGuidance: string[] };
      };
    };
    // recipe-system is the editorial-grounding kind create_ui_spec can emit
    // (operator-authored recipe content). editorial-guidance is NOT in this
    // tool's evidenceKinds, so the lying-lane probe uses the real vocabulary.
    env.evidence.push({
      id: "evidence-9", kind: "recipe-system",
      summary: "Recipe-authored guidance about accent color", basis: "aggregate",
    });
    // provenance.evidenceIds must exactly match envelope evidence IDs
    env.data.provenance.evidenceIds = ["evidence-1", "evidence-9"];
    return env;
  }

  it("rejects corpus-evidence decision backed only by editorial-grounding-kind evidence (lying lane)", () => {
    const p = cloneToolResult(makeValidSuccess("create_ui_spec")) as unknown as ReturnType<typeof cloneToolResult<JsonObject>>;
    const env = addEditorialGroundingEvidence(p);
    // corpus-evidence decision backed ONLY by the editorial-grounding evidence
    env.data.citedDecisions = [{
      id: "cd-lie", field: "color-accent", authority: "corpus-evidence",
      evidenceIds: ["evidence-9"], readiness: "available", sourceId: SAFE_PUBLIC_REFERENCE,
    }];
    // Lying partition: editorial evidence placed in the corpus lane
    env.data.authorityLanes = {
      corpusEvidence: ["evidence-1", "evidence-9"],
      machineRules: [], editorialGuidance: [],
    };
    // colorTokenAuthority is corpus-evidence in the fixture; the valid corpus decision
    // (cd1) was removed above, so add a corpus-observation-backed color decision to
    // keep colorTokenAuthority valid and isolate the failure to cd-lie.
    env.data.citedDecisions.unshift({
      id: "cd-color", field: "color-primary", authority: "corpus-evidence",
      evidenceIds: ["evidence-1"], readiness: "available", sourceId: SAFE_PUBLIC_REFERENCE,
    });
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /cd-lie.*corpus-evidence/i.test(i.message) || /authority.*evidence.*kind/i.test(i.message))).toBe(true);
    }
  });

  it("anti-regression: corpus-evidence decision backed by corpus-observation-kind evidence passes", () => {
    // The valid fixture already models this (cd1 cites evidence-1, kind corpus-observation).
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
      evidenceIds: ["evidence-1"], readiness: "available",
    }];
    // Place the corpus-observation evidence in the editorial lane (lying partition)
    data.authorityLanes = {
      corpusEvidence: [], machineRules: [],
      editorialGuidance: ["evidence-1"],
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
      evidenceIds: ["evidence-1"], readiness: "available", sourceId: SAFE_PUBLIC_REFERENCE,
    }];
    // BUT place that corpus-observation evidence in the WRONG (editorial) lane
    data.authorityLanes = {
      corpusEvidence: [], machineRules: [],
      editorialGuidance: ["evidence-1"],
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
    // Add a recipe-system (editorial-grounding) item alongside the corpus-observation one.
    env.evidence.push({
      id: "evidence-8", kind: "recipe-system",
      summary: "Recipe-authored accent guidance", basis: "aggregate",
    });
    env.data.provenance.evidenceIds = ["evidence-1", "evidence-8"];
    // Two decisions for the SAME exact field with different authorities.
    env.data.citedDecisions = [
      { id: "cd-corpus", field: "color-accent", authority: "corpus-evidence", evidenceIds: ["evidence-1"], readiness: "available", sourceId: SAFE_PUBLIC_REFERENCE },
      { id: "cd-edit", field: "color-accent", authority: "editorial", evidenceIds: ["evidence-8"], readiness: "available" },
    ];
    env.data.authorityLanes = {
      corpusEvidence: ["evidence-1"], machineRules: [],
      editorialGuidance: ["evidence-8"],
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

// ---------------------------------------------------------------------------
// C3: the create_ui_spec contract migration.
//
// Governing invariant for this section: the descriptor must describe what
// `createUiSpec()` actually produces — the real `outputFormat` vocabulary, the
// real retrieval states, and the real response-scoped evidence vocabulary —
// while keeping the two ID domains (public `evidence-N` IDs and safe public
// reference IDs) strictly separate and keeping every legacy evidence row valid.
// ---------------------------------------------------------------------------

describe("C3: CreateUiSpecInput migration", () => {
  const base = { productContext: "A synthetic analytics dashboard" };

  it("rejects the stale serializationFormat field", () => {
    const r = CreateUiSpecInput.safeParse({ ...base, serializationFormat: "brief" });
    expect(r.success).toBe(false);
  });

  it("defaults outputFormat to markdown when absent", () => {
    const r = CreateUiSpecInput.parse({ ...base });
    expect(r.outputFormat).toBe("markdown");
  });

  it("accepts outputFormat json and rejects the old brief/tokens vocabulary", () => {
    expect(CreateUiSpecInput.parse({ ...base, outputFormat: "json" }).outputFormat).toBe("json");
    expect(CreateUiSpecInput.safeParse({ ...base, outputFormat: "brief" }).success).toBe(false);
    expect(CreateUiSpecInput.safeParse({ ...base, outputFormat: "tokens" }).success).toBe(false);
  });

  it("passes target through using the core's closed target vocabulary", () => {
    expect(CreateUiSpecInput.safeParse({ ...base, target: "astro-react" }).success).toBe(true);
    expect(CreateUiSpecInput.safeParse({ ...base, target: "neutral-web" }).success).toBe(true);
    expect(CreateUiSpecInput.safeParse({ ...base, target: "svelte" }).success).toBe(false);
  });

  it("defaults motionIntents to [] and bounds it at 8 structured intents", () => {
    expect(CreateUiSpecInput.parse({ ...base }).motionIntents).toEqual([]);
    const intent = {
      id: "fade-in", trigger: "mount", properties: ["opacity"],
      durationToken: "motion.fast", easingToken: "motion.standard",
      interruptible: true, reducedMotion: "No animation; render final state.",
    };
    expect(CreateUiSpecInput.safeParse({ ...base, motionIntents: [intent] }).success).toBe(true);
    expect(CreateUiSpecInput.safeParse({
      ...base, motionIntents: Array.from({ length: 9 }, (_, i) => ({ ...intent, id: `m${i}` })),
    }).success).toBe(false);
  });

  it("rejects a motion intent that omits the reduced-motion fallback", () => {
    const r = CreateUiSpecInput.safeParse({
      ...base,
      motionIntents: [{
        id: "fade-in", trigger: "mount", properties: ["opacity"],
        durationToken: "motion.fast", easingToken: "motion.standard", interruptible: true,
      }],
    });
    expect(r.success).toBe(false);
  });

  // Drift gate, part 1 — STRUCTURAL. Every field the MCP adapter passes through
  // to the core request must carry the CORE bounds, byte-for-byte in JSON-Schema
  // form. Without this, transport input could be accepted here and then rejected
  // by the producer.
  //
  // Known limitation: `z.toJSONSchema` renders `.trim()`, `.strict()` vs loose,
  // and `.refine()` IDENTICALLY, so this assertion alone cannot see those three
  // kinds of drift. Part 2 below is the behavioural gate that does.
  it("every core request field is mirrored with identical bounds (drift gate, structural)", () => {
    const toJson = (schema: unknown) => z.toJSONSchema(
      schema as unknown as Parameters<typeof z.toJSONSchema>[0],
    ) as { properties?: Record<string, unknown>; required?: string[] };
    const core = toJson(CreateUiSpecRequestSchema);
    const mcp = toJson(CreateUiSpecInput);
    for (const [name, def] of Object.entries(core.properties ?? {})) {
      expect(mcp.properties?.[name], `field "${name}" missing from CreateUiSpecInput`).toEqual(def);
    }
    // The ONLY extra field is the adapter-local presentation selection.
    expect(Object.keys(mcp.properties ?? {}).sort()).toEqual(
      [...Object.keys(core.properties ?? {}), "outputFormat"].sort(),
    );
    // outputFormat is the only additional required-with-default field.
    expect((mcp.required ?? []).filter(n => n !== "outputFormat").sort())
      .toEqual((core.required ?? []).sort());
  });

  // Drift gate, part 2 — BEHAVIOURAL. Parse the same edge inputs through both
  // schemas and require identical accept/reject verdicts and identical parsed
  // values for every shared field. This is what catches the drift JSON Schema
  // cannot render: a dropped `.trim()`, a dropped `.strict()`, a dropped
  // `.refine()`.
  it("accepts and rejects exactly the same edge inputs as the core request (drift gate, behavioural)", () => {
    const ok = { productContext: "A synthetic analytics dashboard" };
    const motionIntent = {
      id: "fade-in", trigger: "mount", properties: ["opacity"],
      durationToken: "motion.fast", easingToken: "motion.standard",
      interruptible: true, reducedMotion: "No animation; render final state.",
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["baseline", ok],
      // .strict() on the NESTED motionIntent mirror (CreateUiSpecMotionIntent vs
      // the canonical MotionIntentSchema) — round-2 review M2 residual: neither
      // the structural gate above (z.toJSONSchema can't see .strict()) nor this
      // gate previously carried a case exercising an extra key on a single
      // motion-intent object, so a dropped nested .strict() would have passed
      // both gates silently.
      ["motion intent with the valid shape", { ...ok, motionIntents: [motionIntent] }],
      ["motion intent object with an unknown key", { ...ok, motionIntents: [{ ...motionIntent, extraKey: "x" }] }],
      // .trim() — whitespace-only and padded values
      ["whitespace-only constraint", { ...ok, constraints: ["   "] }],
      ["padded constraint", { ...ok, constraints: ["  WCAG AA  "] }],
      ["whitespace-only framework", { ...ok, implementationFramework: "   " }],
      ["padded framework", { ...ok, implementationFramework: "  react  " }],
      ["padded productContext under the min after trim", { productContext: "  short  " }],
      ["padded productContext over the min after trim", { productContext: "  a synthetic dashboard  " }],
      ["whitespace-only referenceId", { ...ok, referenceIds: ["   "] }],
      ["padded referenceId", { ...ok, referenceIds: ["  ent-a  "] }],
      // .refine() — referenceIds uniqueness
      ["duplicate referenceIds", { ...ok, referenceIds: ["ent-a", "ent-a"] }],
      ["duplicate referenceIds after trim", { ...ok, referenceIds: ["ent-a", " ent-a "] }],
      // .strict() — unknown key
      ["unknown key", { ...ok, serializationFormat: "brief" }],
      // exact bounds
      ["productContext at max", { productContext: "x".repeat(8_000) }],
      ["productContext over max", { productContext: "x".repeat(8_001) }],
      ["constraints at max count", { ...ok, constraints: Array.from({ length: 12 }, (_, i) => `c${i}`) }],
      ["constraints over max count", { ...ok, constraints: Array.from({ length: 13 }, (_, i) => `c${i}`) }],
      ["constraint at max length", { ...ok, constraints: ["c".repeat(500)] }],
      ["constraint over max length", { ...ok, constraints: ["c".repeat(501)] }],
      ["referenceId at max length", { ...ok, referenceIds: ["r".repeat(200)] }],
      ["referenceId over max length", { ...ok, referenceIds: ["r".repeat(201)] }],
      ["framework at max length", { ...ok, implementationFramework: "f".repeat(120) }],
      ["framework over max length", { ...ok, implementationFramework: "f".repeat(121) }],
      ["six referenceIds", { ...ok, referenceIds: ["a", "b", "c", "d", "e", "f"] }],
    ];
    for (const [label, input] of cases) {
      const core = CreateUiSpecRequestSchema.safeParse(input);
      const mcp = CreateUiSpecInput.safeParse(input);
      expect(mcp.success, `verdict drift for "${label}"`).toBe(core.success);
      if (core.success && mcp.success) {
        const { outputFormat: _adapterLocal, ...shared } = mcp.data as Record<string, unknown>;
        expect(shared, `parsed-value drift for "${label}"`).toEqual(core.data);
      }
    }
  });

  it("target and motionIntents mirror the canonical core schemas", () => {
    const toJson = (schema: unknown) => {
      // A top-level render carries $schema; a nested property render does not.
      const { $schema: _drop, ...rest } = z.toJSONSchema(
        schema as unknown as Parameters<typeof z.toJSONSchema>[0],
      ) as Record<string, unknown>;
      return rest;
    };
    const mcp = toJson(CreateUiSpecInput) as { properties?: Record<string, unknown> };
    expect(mcp.properties?.target).toEqual(toJson(WebTargetId));
    expect(mcp.properties?.motionIntents).toEqual(toJson(z.array(MotionIntentSchema).max(8).default([])));
  });
});

describe("C3: create_ui_spec retrieval policy", () => {
  it("accepts automatic keyword/metadata retrieval", () => {
    const r = ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecAutomatic());
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("accepts the zero-result structured fallback (no-results, attempted keyword)", () => {
    const r = ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecZeroResultFallback());
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("accepts explicit references as none/none with one spec artifact", () => {
    const r = ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecExplicitReferences());
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("rejects keyword/text (the automatic path is metadata-only)", () => {
    const p = makeCreateUiSpecAutomatic();
    (p.retrieval as Record<string, unknown>).modality = "text";
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("rejects a recovery fallbackReason on the structured fallback", () => {
    const p = makeCreateUiSpecZeroResultFallback();
    (p.retrieval as Record<string, unknown>).fallbackReason = "missing-index";
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("rejects an attempted mode outside the keyword path", () => {
    const p = makeCreateUiSpecZeroResultFallback();
    (p.retrieval as Record<string, unknown>).attemptedModes = ["vector"];
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("maps a core retrieval failure to the retryable PROVIDER_ERROR, not a new code", () => {
    const desc = TOOL_DESCRIPTORS.find(d => d.name === "create_ui_spec")!;
    expect([...desc.errorCodes].sort()).toEqual(["INVALID_INPUT", "PROVIDER_ERROR"]);
    const err = makeValidError("create_ui_spec")!;
    err.error = { code: "PROVIDER_ERROR", message: "Retrieval unavailable.", retryable: true };
    err.summary = "Retrieval unavailable.";
    const r = ToolResultSchemas.create_ui_spec.safeParse(err);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    // A non-retryable PROVIDER_ERROR is a type AND runtime error.
    err.error = { code: "PROVIDER_ERROR", message: "Retrieval unavailable.", retryable: false };
    expect(ToolResultSchemas.create_ui_spec.safeParse(err).success).toBe(false);
    // No new transport code is introduced.
    err.error = { code: "RETRIEVAL_UNAVAILABLE", message: "Retrieval unavailable.", retryable: true };
    expect(ToolResultSchemas.create_ui_spec.safeParse(err).success).toBe(false);
  });
});

describe("C3: allowNoneWithPositiveResult capability", () => {
  it("is declared only for create_ui_spec", () => {
    for (const d of TOOL_DESCRIPTORS) {
      const flag = (d as { allowNoneWithPositiveResult?: boolean }).allowNoneWithPositiveResult;
      expect(flag === true, `tool ${d.name}`).toBe(d.name === "create_ui_spec");
    }
  });

  it("anti-regression: a retrieval-capable tool WITHOUT the capability still rejects none + positive count", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const r = p.retrieval as Record<string, unknown>;
    r.mode = "none"; r.modality = "none";
    const parsed = ToolResultSchemas.search_ui_references.safeParse(p);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => /mode none with positive resultCount/i.test(i.message))).toBe(true);
    }
  });
});

describe("C3: shared evidence contract", () => {
  const ev = (row: Record<string, unknown>) => Evidence.safeParse({ summary: "x", ...row });

  it("permits a response-scoped corpus-observation with no referenceId", () => {
    expect(ev({ id: "evidence-7", kind: "corpus-observation", basis: "visible" }).success).toBe(true);
  });

  it("keeps a non-response-scoped corpus row subject to the referenceId requirement", () => {
    expect(ev({ id: "evidence-corpus-a", kind: "corpus-observation", basis: "visible" }).success).toBe(false);
    expect(ev({ id: "evidence-corpus-a", kind: "corpus-observation", basis: "visible", referenceId: "ref-a" }).success).toBe(true);
  });

  it("forbids a referenceId on a response-scoped corpus-observation (no public citation)", () => {
    expect(ev({ id: "evidence-7", kind: "corpus-observation", basis: "visible", referenceId: "ref-a" }).success).toBe(false);
  });

  it("public-reference requires the user-supplied basis and a public referenceId", () => {
    expect(ev({ id: "evidence-2", kind: "public-reference", basis: "user-supplied", referenceId: "ref-a" }).success).toBe(true);
    expect(ev({ id: "evidence-2", kind: "public-reference", basis: "visible", referenceId: "ref-a" }).success).toBe(false);
    expect(ev({ id: "evidence-2", kind: "public-reference", basis: "user-supplied" }).success).toBe(false);
  });

  it("recipe-system is operator content: aggregate basis, never a referenceId", () => {
    expect(ev({ id: "evidence-1", kind: "recipe-system", basis: "aggregate" }).success).toBe(true);
    expect(ev({ id: "evidence-1", kind: "recipe-system", basis: "user-supplied" }).success).toBe(false);
    expect(ev({ id: "evidence-1", kind: "recipe-system", basis: "editorial" }).success).toBe(false);
    expect(ev({ id: "evidence-1", kind: "recipe-system", basis: "aggregate", referenceId: "ref-a" }).success).toBe(false);
  });

  it("the new bases are not reachable from the legacy kinds", () => {
    expect(ev({ id: "evidence-7", kind: "corpus-observation", basis: "aggregate" }).success).toBe(false);
    expect(ev({ id: "e1", kind: "screen-observation", basis: "user-supplied" }).success).toBe(false);
    expect(ev({ id: "e1", kind: "machine-rule", basis: "aggregate" }).success).toBe(false);
    expect(ev({ id: "e1", kind: "editorial-guidance", basis: "aggregate" }).success).toBe(false);
    expect(ev({ id: "e1", kind: "dom-signal", basis: "user-supplied" }).success).toBe(false);
  });

  it("anti-regression: every legacy kind/basis pair still parses as before", () => {
    expect(ev({ id: "e1", kind: "corpus-observation", basis: "inferred", referenceId: "ref-a" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "screen-observation", basis: "visible" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "screen-observation", basis: "inferred" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "dom-signal", basis: "dom-grounded" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "dom-signal", basis: "visible" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "machine-rule", basis: "inferred" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "machine-rule", basis: "editorial" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "editorial-guidance", basis: "editorial" }).success).toBe(true);
    expect(ev({ id: "e1", kind: "editorial-guidance", basis: "visible" }).success).toBe(false);
    expect(ev({ id: "e1", kind: "dom-signal", basis: "inferred" }).success).toBe(false);
  });

  it("create_ui_spec accepts exactly the kinds its adapter can emit", () => {
    const desc = TOOL_DESCRIPTORS.find(d => d.name === "create_ui_spec")!;
    expect([...desc.evidenceKinds]).toEqual(["corpus-observation", "public-reference", "recipe-system"]);
    const p = makeCreateUiSpecAutomatic();
    (p.evidence as Array<Record<string, unknown>>)[1] = {
      id: "evidence-2", kind: "editorial-guidance", summary: "x", basis: "editorial",
    };
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path[0] === "evidence")).toBe(true);
  });

  it("recipe-system evidence grounds an editorial decision; a corpus observation does not", () => {
    const p = makeCreateUiSpecAutomatic();
    const data = p.data as Record<string, unknown>;
    // Swap the decision's grounding to the corpus observation (wrong kind + wrong lane).
    (data.citedDecisions as Array<Record<string, unknown>>)[0]!.evidenceIds = ["evidence-2"];
    (data.acceptanceCriteria as Array<Record<string, unknown>>)[0]!.evidenceIds = ["evidence-2"];
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("rejects recipe-system grounding that is not in the editorialGuidance lane", () => {
    const p = makeCreateUiSpecAutomatic();
    const data = p.data as Record<string, unknown>;
    (data.authorityLanes as Record<string, unknown>).editorialGuidance = [];
    (data.authorityLanes as Record<string, unknown>).corpusEvidence = ["evidence-1", "evidence-2"];
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  // I1: the corpus-evidence branch requires every referenced corpus-observation
  // to sit in the corpus lane, but the editorial branch had no matching rule, so
  // an editorial decision could CO-cite a corpus observation alongside the recipe
  // row — corpus-derived evidence presented under editorial authority.
  it("rejects an editorial decision that co-cites a corpus observation (corpus row in the corpus lane)", () => {
    const p = makeCreateUiSpecAutomatic();
    const data = p.data as Record<string, unknown>;
    // evidence-1 = recipe-system (editorial lane), evidence-2 = corpus-observation (corpus lane)
    (data.citedDecisions as Array<Record<string, unknown>>)[0]!.evidenceIds = ["evidence-1", "evidence-2"];
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /editorial authority.*corpus-observation/i.test(i.message))).toBe(true);
    }
  });

  it("rejects an editorial decision that co-cites a corpus observation moved into the editorialGuidance lane", () => {
    const p = makeCreateUiSpecAutomatic();
    const data = p.data as Record<string, unknown>;
    (data.citedDecisions as Array<Record<string, unknown>>)[0]!.evidenceIds = ["evidence-1", "evidence-2"];
    (data.authorityLanes as Record<string, unknown>).corpusEvidence = [];
    (data.authorityLanes as Record<string, unknown>).editorialGuidance = ["evidence-1", "evidence-2"];
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => /corpus-observation/i.test(i.message))).toBe(true);
    }
  });

  it("rejects a corpus-observation partitioned into the editorialGuidance lane at all", () => {
    // Not cited by any editorial decision — the partition itself is the lie.
    const p = makeCreateUiSpecAutomatic();
    const data = p.data as Record<string, unknown>;
    (data.authorityLanes as Record<string, unknown>).corpusEvidence = [];
    (data.authorityLanes as Record<string, unknown>).editorialGuidance = ["evidence-1", "evidence-2"];
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      // The message names the POSITION and withholds the value (Task 1b: an
      // error string that repeats an offending ID is itself a leak channel).
      expect(r.error.issues.some(i => /corpus-observation evidence ID must not be partitioned into the editorialGuidance lane/i.test(i.message))).toBe(true);
      expect(r.error.issues.some(i => /"evidence-2"/.test(i.message))).toBe(false);
    }
  });

  it("anti-regression: recipe-system still grounds editorial authority on its own", () => {
    expect(ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecAutomatic()).success).toBe(true);
  });
});

describe("C3: public evidence IDs and public reference IDs are separate domains", () => {
  it("extractReferenceIds reads ONLY UiSpec.citedReferences", () => {
    const desc = TOOL_DESCRIPTORS.find(d => d.name === "create_ui_spec")!;
    expect([...desc.extractReferenceIds({
      citedReferences: [SAFE_PUBLIC_REFERENCE],
      provenance: { evidenceIds: ["evidence-1", "evidence-2"], sourceReferences: [SAFE_PUBLIC_REFERENCE] },
      authorityLanes: { corpusEvidence: ["evidence-2"], machineRules: [], editorialGuidance: ["evidence-1"] },
    })]).toEqual([SAFE_PUBLIC_REFERENCE]);
    expect([...desc.extractReferenceIds({ provenance: { evidenceIds: ["evidence-1"] } })]).toEqual([]);
  });

  it("an evidence ID may never be substituted into referenceId", () => {
    expect(Evidence.safeParse({
      id: "evidence-2", kind: "public-reference", basis: "user-supplied",
      summary: "x", referenceId: "evidence-1",
    }).success).toBe(false);
  });

  it("an evidence ID may never be substituted into citedReferences/referenceIds", () => {
    const p = makeCreateUiSpecExplicitReferences();
    const data = p.data as Record<string, unknown>;
    data.citedReferences = ["evidence-2"];
    (data.provenance as Record<string, unknown>).sourceReferences = ["evidence-2"];
    (p.evidence as Array<Record<string, unknown>>)[1]!.referenceId = "evidence-2";
    p.referenceIds = ["evidence-2"];
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
  });

  it("automatic corpus evidence never produces a top-level referenceId", () => {
    const p = makeCreateUiSpecAutomatic();
    p.referenceIds = ["evidence-2"];
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C1: a public reference must BE a safe public reference, not merely "not an
// evidence ID". The producer's only public citation shape is the opaque digest
// `ref-<sha256>` (src/create-ui-spec.ts builds `ref-${sha256Hex(...)}`), so a
// corpus entry ID, a source URL or a filesystem path in any public reference
// position is a leak the descriptor must fail closed on.
//
// Scoped to create_ui_spec: other tools legitimately carry corpus entry IDs in
// referenceIds, so this shape rule lives in this tool's refineEnvelope only.
// ---------------------------------------------------------------------------

describe("C3: public references must be safe opaque digests (never a path, URL or corpus ID)", () => {
  const UNSAFE: Array<[string, string]> = [
    ["a private filesystem path", "/Users/x/corpus/images-private/shot.png"],
    ["a source URL", "https://dribbble.com/shots/123-private"],
    ["a raw corpus entry ID", "ent_9f2a-dribbble-4471"],
    ["a response-scoped evidence ID", "evidence-1"],
  ];

  /** The shape check fires for non-evidence-ID values; evidence IDs hit the
   *  pre-existing ID-domain rule. Either way the value must be rejected. */
  const needle = (value: string) =>
    /^evidence-[0-9]+$/.test(value) ? /public reference/i : /is not a safe public reference/i;

  function rejects(p: JsonObject, value: string, position: RegExp) {
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => needle(value).test(i.message))).toBe(true);
      expect(r.error.issues.some(i => position.test(i.message) || needle(value).test(i.message))).toBe(true);
    }
  }

  for (const [label, value] of UNSAFE) {
    it(`rejects ${label} in data.citedReferences`, () => {
      const p = makeCreateUiSpecExplicitReferences();
      const data = p.data as Record<string, unknown>;
      data.citedReferences = [value];
      (data.provenance as Record<string, unknown>).sourceReferences = [value];
      rejects(p, value, /citedReferences/);
    });

    it(`rejects ${label} in the top-level referenceIds`, () => {
      const p = makeCreateUiSpecExplicitReferences();
      p.referenceIds = [value];
      rejects(p, value, /referenceIds/);
    });

    it(`rejects ${label} as an evidence row referenceId`, () => {
      const p = makeCreateUiSpecExplicitReferences();
      (p.evidence as Array<Record<string, unknown>>)[1]!.referenceId = value;
      rejects(p, value, /evidence/);
    });
  }

  it("rejects the full envelope carrying a private path in every reference position", () => {
    const value = "/Users/x/corpus/images-private/shot.png";
    const p = makeCreateUiSpecExplicitReferences();
    const data = p.data as Record<string, unknown>;
    p.referenceIds = [value];
    data.citedReferences = [value];
    (data.provenance as Record<string, unknown>).sourceReferences = [value];
    (p.evidence as Array<Record<string, unknown>>)[1]!.referenceId = value;
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      // All three positions are reported, and no issue message echoes the path
      // back into the output.
      const messages = r.error.issues.map(i => i.message);
      expect(messages.some(m => /citedReferences\[0\] is not a safe public reference/.test(m))).toBe(true);
      expect(messages.some(m => /referenceIds\[0\] is not a safe public reference/.test(m))).toBe(true);
      expect(messages.some(m => /evidence\[1\]\.referenceId is not a safe public reference/.test(m))).toBe(true);
      expect(messages.some(m => m.includes(value))).toBe(false);
    }
  });

  it("anti-regression: the producer's real ref-<sha256> shape is accepted in all three positions", () => {
    const r = ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecExplicitReferences());
    expect(r.success).toBe(true);
  });

  it("anti-regression: other tools may still carry corpus entry IDs in referenceIds", () => {
    // search_ui_references publishes real corpus entry IDs; the create_ui_spec
    // shape rule must not have leaked into the shared envelope.
    const r = ToolResultSchemas.search_ui_references.safeParse(
      cloneToolResult(makeValidSuccess("search_ui_references")),
    );
    expect(r.success).toBe(true);
  });
});

describe("C3: status \"error\" requires empty evidence (error-branch reference-safety guard)", () => {
  // Round-2 review finding I-new: rules 4-13 (including refineEnvelope, the
  // safe-public-reference checks and the per-tool evidenceKinds check) all live
  // inside `if (val.status === "ok" ...)`. An error envelope bypasses every one
  // of them, so an evidence row on the error branch could carry a private path,
  // a source URL, a raw corpus ID, or an evidence kind outside this tool's
  // vocabulary. The only pre-existing error-branch guard is "referenceIds must
  // be empty" (:1764-1765); evidence had no equivalent.
  function errorEnvelopeWithEvidence(evidence: unknown[]): JsonObject {
    return {
      tool: "create_ui_spec", schemaVersion: "1.0", status: "error", data: null,
      summary: "Invalid input", referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false, attemptedCount: 0, attemptedModes: [] },
      warnings: [],
      error: { code: "INVALID_INPUT", message: "Invalid input", retryable: false },
      evidence,
    };
  }

  it("rejects a private filesystem path in an error-branch evidence referenceId", () => {
    const p = errorEnvelopeWithEvidence([{
      id: "evidence-2", kind: "public-reference", basis: "user-supplied", summary: "x",
      referenceId: "/Users/olaniyi/corpus/images-private/dribbble-4471.png",
    }]);
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => /empty evidence/i.test(i.message))).toBe(true);
  });

  it("rejects a source URL in an error-branch evidence referenceId", () => {
    const p = errorEnvelopeWithEvidence([{
      id: "evidence-2", kind: "public-reference", basis: "user-supplied", summary: "x",
      referenceId: "https://dribbble.com/shots/123-private",
    }]);
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("rejects a raw corpus entry ID in an error-branch evidence referenceId", () => {
    const p = errorEnvelopeWithEvidence([{
      id: "evidence-2", kind: "public-reference", basis: "user-supplied", summary: "x",
      referenceId: "ent_9f2a-dribbble-4471",
    }]);
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("rejects an evidence kind outside create_ui_spec's vocabulary on the error branch", () => {
    const p = errorEnvelopeWithEvidence([{
      id: "evidence-2", kind: "screen-observation", basis: "visible", summary: "x",
    }]);
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(false);
  });

  it("anti-regression: an error envelope with empty evidence still parses (every real error fixture)", () => {
    const p = errorEnvelopeWithEvidence([]);
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 1b: the structural leaf-value gate.
//
// Rounds 1-3 of the Task 1 review each found the same leak class on a different
// axis (missed reference positions, then the unguarded error branch, then the
// evidence-ID domain having no positive shape rule). The mechanism was always
// the same: a hand-maintained list of coordinates, so the next added field is
// unprotected by default.
//
// The gate replaces that with ONE walker over every string leaf reachable under
// `data`, `referenceIds` and `evidence`, classifying each leaf position into
// exactly three classes and REJECTING anything unclassified. The fail-closed
// default is the property that ends the class: a field added by a later task is
// refused until someone classifies it deliberately.
// ---------------------------------------------------------------------------

describe("Task 1b: structural leaf-value gate (create_ui_spec)", () => {
  const PRIVATE_PATH = "/Users/olaniyi/corpus/images-private/dribbble-4471.png";
  const SOURCE_URL = "https://dribbble.com/shots/123-private";
  const RAW_CORPUS_ID = "ent_9f2a-dribbble-4471";

  const UNSAFE_VALUES: Array<[string, string]> = [
    ["a private filesystem path", PRIVATE_PATH],
    ["a source URL", SOURCE_URL],
    ["a raw corpus entry ID", RAW_CORPUS_ID],
  ];

  /**
   * Rename evidence[index].id to `value` in the evidence row AND in every
   * position the ID propagates to, so the membership rules stay satisfied and
   * the ONLY thing that can reject the envelope is the value-shape gate.
   */
  function renameEvidenceId(p: JsonObject, index: number, value: string): JsonObject {
    const data = p.data as Record<string, unknown>;
    const evidence = p.evidence as Array<Record<string, unknown>>;
    const old = evidence[index]!.id as string;
    evidence[index]!.id = value;
    const swap = (ids: readonly string[]) => ids.map(id => (id === old ? value : id));
    const prov = data.provenance as Record<string, string[]>;
    prov.evidenceIds = swap(prov.evidenceIds);
    const lanes = data.authorityLanes as Record<string, string[]>;
    lanes.corpusEvidence = swap(lanes.corpusEvidence);
    lanes.machineRules = swap(lanes.machineRules);
    lanes.editorialGuidance = swap(lanes.editorialGuidance);
    for (const cd of data.citedDecisions as Array<Record<string, unknown>>)
      cd.evidenceIds = swap(cd.evidenceIds as string[]);
    for (const ac of data.acceptanceCriteria as Array<Record<string, unknown>>)
      ac.evidenceIds = swap(ac.evidenceIds as string[]);
    return p;
  }

  function issues(p: JsonObject) {
    const r = ToolResultSchemas.create_ui_spec.safeParse(p);
    return r.success ? null : r.error.issues;
  }

  // --- Class 1: public evidence ID (^evidence-[0-9]+$) --------------------

  it("positive: the producer's evidence-N IDs are accepted in every evidence-ID position", () => {
    expect(ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecAutomatic()).success).toBe(true);
    expect(ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecExplicitReferences()).success).toBe(true);
    expect(ToolResultSchemas.create_ui_spec.safeParse(makeCreateUiSpecZeroResultFallback()).success).toBe(true);
  });

  for (const [label, value] of UNSAFE_VALUES) {
    it(`negative: rejects ${label} as evidence[].id (and its four propagation positions)`, () => {
      const found = issues(renameEvidenceId(makeCreateUiSpecAutomatic(), 0, value));
      expect(found).not.toBeNull();
      expect(found!.some(i => /must be a response-scoped public evidence ID/.test(i.message))).toBe(true);
      // The message must never reproduce the offending value.
      expect(found!.some(i => i.message.includes(value))).toBe(false);
    });
  }

  it("negative: rejects a safe public reference ID in an evidence-ID position (domains stay separate)", () => {
    const found = issues(renameEvidenceId(makeCreateUiSpecAutomatic(), 0, SAFE_PUBLIC_REFERENCE));
    expect(found).not.toBeNull();
    expect(found!.some(i => /must be a response-scoped public evidence ID/.test(i.message))).toBe(true);
  });

  it("negative: rejects a private path in data.provenance.evidenceIds alone", () => {
    const p = makeCreateUiSpecAutomatic();
    ((p.data as Record<string, unknown>).provenance as Record<string, string[]>).evidenceIds = [PRIVATE_PATH];
    const found = issues(p);
    expect(found).not.toBeNull();
    expect(found!.some(i => /data\.provenance\.evidenceIds\[\] must be a response-scoped public evidence ID/.test(i.message))).toBe(true);
    expect(found!.some(i => i.message.includes(PRIVATE_PATH))).toBe(false);
  });

  it("negative: rejects a private path in each remaining evidence-ID position, without echoing it", () => {
    const positions: Array<[string, (data: Record<string, unknown>) => void]> = [
      ["data.authorityLanes.corpusEvidence[]", d => { (d.authorityLanes as Record<string, string[]>).corpusEvidence = [PRIVATE_PATH]; }],
      ["data.authorityLanes.machineRules[]", d => { (d.authorityLanes as Record<string, string[]>).machineRules = [PRIVATE_PATH]; }],
      ["data.authorityLanes.editorialGuidance[]", d => { (d.authorityLanes as Record<string, string[]>).editorialGuidance = [PRIVATE_PATH]; }],
      ["data.citedDecisions[].evidenceIds[]", d => { (d.citedDecisions as Array<Record<string, unknown>>)[0]!.evidenceIds = [PRIVATE_PATH]; }],
      ["data.acceptanceCriteria[].evidenceIds[]", d => { (d.acceptanceCriteria as Array<Record<string, unknown>>)[0]!.evidenceIds = [PRIVATE_PATH]; }],
    ];
    for (const [position, mutate] of positions) {
      const p = makeCreateUiSpecAutomatic();
      mutate(p.data as Record<string, unknown>);
      const found = issues(p);
      expect(found, position).not.toBeNull();
      expect(found!.some(i => i.message.includes(`${position} must be a response-scoped public evidence ID`)), position).toBe(true);
      expect(found!.some(i => i.message.includes(PRIVATE_PATH)), position).toBe(false);
    }
  });

  // --- Class 2: safe public reference (^ref-[0-9a-f]{64}$) ----------------

  it("negative: rejects a private path in every reference position, without echoing it", () => {
    const positions: Array<[string, (p: JsonObject) => void]> = [
      ["referenceIds[]", p => { p.referenceIds = [PRIVATE_PATH]; }],
      ["data.citedReferences[]", p => { ((p.data as Record<string, unknown>).citedReferences as string[])[0] = PRIVATE_PATH; }],
      ["data.provenance.sourceReferences[]", p => { ((p.data as Record<string, unknown>).provenance as Record<string, string[]>).sourceReferences = [PRIVATE_PATH]; }],
      ["evidence[].referenceId", p => { (p.evidence as Array<Record<string, unknown>>)[1]!.referenceId = PRIVATE_PATH; }],
      ["data.citedDecisions[].sourceId", p => { (((p.data as Record<string, unknown>).citedDecisions) as Array<Record<string, unknown>>)[0]!.sourceId = PRIVATE_PATH; }],
      ["data.techniques[].sourceIds[]", p => { ((p.data as Record<string, unknown>).techniques as Array<Record<string, unknown>>).push({ text: "t", sourceIds: [PRIVATE_PATH] }); }],
      ["data.antiPatterns[].sourceIds[]", p => { ((p.data as Record<string, unknown>).antiPatterns as Array<Record<string, unknown>>).push({ text: "a", sourceIds: [PRIVATE_PATH] }); }],
      ["data.componentInventory[].sourceId", p => { ((p.data as Record<string, unknown>).componentInventory as Array<Record<string, unknown>>).push({ name: "n", pattern: "p", sourceId: PRIVATE_PATH }); }],
    ];
    for (const [position, mutate] of positions) {
      const p = makeCreateUiSpecExplicitReferences();
      mutate(p);
      const found = issues(p);
      expect(found, position).not.toBeNull();
      expect(found!.some(i => i.message.includes(`${position} must be a safe public reference ID`)), position).toBe(true);
      expect(found!.some(i => i.message.includes(PRIVATE_PATH)), position).toBe(false);
    }
  });

  it("negative: rejects a public evidence ID in a reference position (domains stay separate)", () => {
    const p = makeCreateUiSpecExplicitReferences();
    (p.data as Record<string, unknown>).citedReferences = ["evidence-1"];
    const found = issues(p);
    expect(found).not.toBeNull();
    expect(found!.some(i => /data\.citedReferences\[\]/.test(i.message))).toBe(true);
  });

  // --- Class 3: free text, only at allowlisted positions ------------------

  it("positive: arbitrary text is accepted at allowlisted free-text positions", () => {
    const p = makeCreateUiSpecAutomatic();
    const data = p.data as Record<string, unknown>;
    data.designDirection = "Slashes / colons: and https:// prose are fine in the brief echo";
    (data.context as Record<string, unknown>).productContext = "A dashboard for /admin with C:\\legacy paths";
    data.interactions = ["Hover reveals a tooltip — arbitrary prose"];
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(true);
  });

  // --- The whole point: fail closed on an unclassified position -----------

  it("FAIL-CLOSED: a string leaf at an unclassified path is rejected", () => {
    const found = findUnsafeCreateUiSpecLeaves({
      data: { specVersion: "1.0", futureFieldTask2Adds: PRIVATE_PATH },
      referenceIds: [],
      evidence: [],
    });
    expect(found.some(v => v.position === "data.futureFieldTask2Adds")).toBe(true);
    expect(found.some(v => /not a classified/.test(v.message))).toBe(true);
    expect(found.some(v => v.message.includes(PRIVATE_PATH))).toBe(false);
  });

  it("FAIL-CLOSED: an unclassified nested string leaf is rejected", () => {
    const found = findUnsafeCreateUiSpecLeaves({
      data: { provenance: { newProvenanceField: SOURCE_URL } },
      referenceIds: [],
      evidence: [{ newEvidenceField: RAW_CORPUS_ID }],
    });
    expect(found.map(v => v.position)).toEqual(
      expect.arrayContaining(["data.provenance.newProvenanceField", "evidence[].newEvidenceField"]),
    );
  });

  it("FAIL-CLOSED: an unclassified leaf inside an array of objects is rejected", () => {
    const found = findUnsafeCreateUiSpecLeaves({
      data: { citedDecisions: [{ id: "cd1", newDecisionField: PRIVATE_PATH }] },
      referenceIds: [],
      evidence: [],
    });
    expect(found.some(v => v.position === "data.citedDecisions[].newDecisionField")).toBe(true);
  });

  it("the gate is wired into the envelope schema, not merely exported", () => {
    // Every violation the gate finds must surface as a parse issue.
    const p = renameEvidenceId(makeCreateUiSpecAutomatic(), 0, PRIVATE_PATH);
    const found = findUnsafeCreateUiSpecLeaves({ data: p.data, referenceIds: p.referenceIds, evidence: p.evidence });
    expect(found.length).toBeGreaterThan(0);
    const parsed = issues(p);
    expect(parsed).not.toBeNull();
    for (const v of found) expect(parsed!.some(i => i.message === v.message)).toBe(true);
  });

  it("the gate runs on the error branch too (no branch condition can skip it)", () => {
    // The error branch is closed by construction (data null, referenceIds [],
    // evidence []), so the gate finds nothing — but it still RUNS: an error
    // envelope carrying data leaves is reported by the gate as well.
    const found = findUnsafeCreateUiSpecLeaves({
      data: { provenance: { evidenceIds: [PRIVATE_PATH] } },
      referenceIds: [],
      evidence: [],
    });
    expect(found.some(v => v.position === "data.provenance.evidenceIds[]")).toBe(true);
    const p = makeValidError("create_ui_spec")!;
    expect(ToolResultSchemas.create_ui_spec.safeParse(p).success).toBe(true);
  });

  it("non-string leaves (numbers, booleans, null) are not flagged", () => {
    expect(findUnsafeCreateUiSpecLeaves({
      data: { motionGuidance: { notes: [], evidenceUnavailable: true }, colorTokens: null },
      referenceIds: [],
      evidence: [],
    })).toEqual([]);
  });

  it("anti-regression: the eleven other tools' fixtures still validate", () => {
    for (const desc of TOOL_DESCRIPTORS) {
      if (desc.name === "create_ui_spec") continue;
      const schema = (ToolResultSchemas as Record<string, z.ZodType>)[desc.name]!;
      const ok = schema.safeParse(cloneToolResult(makeValidSuccess(desc.name as never)));
      expect(ok.success, desc.name).toBe(true);
    }
  });
});
