/**
 * Valid synthetic fixtures for every tool contract.
 * No corpus/private data — all IDs are synthetic.
 */
import type { ToolName } from "../tool-contracts.js";

export type JsonObject = Record<string, unknown>;

export const VALID_TOOL_INPUTS = {
  search_ui_references: {},
  get_ui_reference: { id: "ref-a" },
  find_similar_ui_references: { id: "ref-a" },
  compare_ui_references: { ids: ["ref-a", "ref-b"] },
  get_ui_taxonomy: {},
  browse_ui_patterns: {},
  plan_ui_direction: { productContext: "A synthetic analytics dashboard" },
  create_ui_spec: { productContext: "A synthetic analytics dashboard" },
  research_ui_anti_patterns: {},
  research_ui_palettes: {},
  research_ui_techniques: {},
  critique_ui: {
    image_data: "c3ludGhldGlj",
    image_mime_type: "image/png",
  },
} as const satisfies Record<ToolName, JsonObject>;

function successEnvelope(
  tool: string,
  data: JsonObject,
  referenceIds: string[],
  resultCount: number,
): JsonObject {
  return {
    tool,
    schemaVersion: "1.0",
    status: "ok",
    summary: "Synthetic valid result",
    data,
    referenceIds,
    retrieval: {
      mode: "none",
      modality: "none",
      resultCount,
      fallbackUsed: false,
      attemptedCount: 0,
      attemptedModes: [],
    },
    warnings: [],
  };
}

// Shared data fragments
const refSummary = (id: string): JsonObject => ({
  id,
  title: `Title for ${id}`,
  product: "Synthetic Product",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  qualityScore: 5,
  qualityTier: "exceptional",
  source: { productName: "Synthetic", url: null, imageAvailable: false },
  critique: "Synthetic critique text.",
  topTechniques: ["technique-a"],
  antiPatterns: [],
});

const similarRef = (id: string): JsonObject => ({
  id,
  title: `Title for ${id}`,
  product: "Synthetic Product",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  score: 0.85,
  basis: "text-vector",
  critique: "Synthetic critique.",
  techniques: ["technique-a"],
});

const fullRef = (id: string): JsonObject => ({
  id,
  title: `Title for ${id}`,
  product: "Synthetic Product",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  qualityScore: 5,
  qualityTier: "exceptional",
  platform: "web",
  layout: "sidebar",
  accentColor: "#3b82f6",
  dominantColors: ["#ffffff", "#1e293b"],
  colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" },
  typePairing: { display: "Inter", body: "Inter", notes: "Geometric" },
  spacingDensity: "comfortable",
  cornerStyle: "rounded",
  usesShadows: true,
  usesBorders: false,
  critique: "Synthetic critique.",
  techniques: ["technique-a"],
  antiPatterns: ["anti-pattern-a"],
  whereThisFails: ["fails-when-dense"],
  accessibility: [{ element: "button", risk: "Low contrast", wcag: ["1.4.3"] }],
  source: { productName: "Synthetic", url: null, imageAvailable: false },
  imageAvailable: false,
});

const comparisonRow = (id: string): JsonObject => ({
  id,
  title: `Title for ${id}`,
  product: "Synthetic",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  platform: "web",
  layout: "sidebar",
  accent: "#3b82f6",
  density: "comfortable",
  corners: "rounded",
  quality: "5/5 exceptional",
  critiqueAngle: "Good hierarchy.",
  topTechnique: "technique-a",
  antiPatterns: [],
  whereItFails: "N/A",
  accessibility: "None identified.",
});

const taxonomyList = (values: string[]): JsonObject => ({
  count: values.length,
  values,
});

const patternGroup = (exemplarId: string): JsonObject => ({
  patternType: "dashboard",
  count: 3,
  topProducts: ["Synthetic"],
  exemplar: { id: exemplarId, title: `Title for ${exemplarId}`, product: "Synthetic", qualityScore: 5, critique: "Exemplar critique." },
});

const planEvidence = [
  { id: "evidence-corpus-a", referenceId: "ref-a", kind: "corpus-observation", summary: "Uses a 12-column grid.", basis: "visible" },
];

export function makeValidSuccess(tool: ToolName): JsonObject {
  switch (tool) {
    case "search_ui_references":
      return successEnvelope(tool, { results: [refSummary("ref-a")] }, ["ref-a"], 1);

    case "get_ui_reference":
      return successEnvelope(tool, fullRef("ref-a"), ["ref-a"], 1);

    case "find_similar_ui_references":
      return successEnvelope(tool, { results: [similarRef("ref-b")] }, ["ref-b"], 1);

    case "compare_ui_references": {
      const env = successEnvelope(tool, {
        entries: [comparisonRow("ref-a")],
        foundIds: ["ref-a"],
        missingIds: ["ref-b"],
      }, ["ref-a"], 1);
      (env as JsonObject).warnings = [{ code: "partialResult", message: "1 of 2 IDs not found" }];
      return env;
    }

    case "get_ui_taxonomy":
      return successEnvelope(tool, {
        patternTypes: taxonomyList(["dashboard"]),
        categories: taxonomyList(["dashboard"]),
        styleTags: taxonomyList(["minimal"]),
      }, [], 0);

    case "browse_ui_patterns":
      return successEnvelope(tool, { patterns: [patternGroup("ref-a")] }, ["ref-a"], 1);

    case "plan_ui_direction": {
      const env = successEnvelope(tool, {
        direction: "Calm, data-dense layout",
        rejectedDefaults: [],
        recommendation: "Use a sidebar layout",
        rationale: "Grounded in corpus evidence",
        evidenceContributions: ["ref-a"],
        structuredDecisions: [{
          field: "color-primary", value: "#3b82f6",
          authority: "corpus-evidence", evidenceIds: ["evidence-corpus-a"],
        }],
      }, ["ref-a"], 1);
      (env as JsonObject).evidence = planEvidence;
      return env;
    }

    case "create_ui_spec": {
      const env = successEnvelope(tool, {
        specVersion: "1.0",
        context: { productContext: "A synthetic analytics dashboard" },
        designDirection: "Calm, data-dense layout",
        rejectedDefaults: [],
        layoutRegions: [{ name: "Main", type: "content", components: ["chart"], responsive: [] }],
        responsiveBehavior: [],
        componentInventory: [{ name: "Chart", pattern: "bar-chart" }],
        colorTokens: { primary: "#3b82f6", surface: "#fff", ink: "#1e293b", muted: "#64748b", accent: "#3b82f6" },
        colorTokenAuthority: "corpus-evidence",
        typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
        typographyTokenAuthority: "corpus-evidence",
        interactions: [],
        motionGuidance: { notes: [], evidenceUnavailable: true },
        accessibilityConstraints: ["Contrast meets WCAG AA"],
        techniques: [{ text: "Use 8px spacing", sourceIds: ["ref-a"] }],
        antiPatterns: [],
        unavailableDecisions: [{ field: "motion", reason: "No DOM motion evidence available" }],
        acceptanceCriteria: [{
          id: "ac1", subject: "contrast", assertion: "meets-contrast",
          expectedOutcome: "4.5:1", verifier: "axe", priority: "must",
          evidenceIds: ["evidence-corpus-a"],
        }],
        citedReferences: ["ref-a"],
        citedDecisions: [{
          id: "cd1", field: "color-primary", authority: "corpus-evidence",
          evidenceIds: ["evidence-corpus-a"], readiness: "available", sourceId: "ref-a",
        }],
        authorityLanes: { corpusEvidence: ["evidence-corpus-a"], machineRules: [], editorialGuidance: [] },
        provenance: {
          generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0",
          sourceReferences: ["ref-a"], evidenceIds: ["evidence-corpus-a"],
        },
      }, ["ref-a"], 1);
      (env as JsonObject).evidence = [
        { id: "evidence-corpus-a", referenceId: "ref-a", kind: "corpus-observation", summary: "Uses a 12-column grid.", basis: "visible" },
      ];
      (env as JsonObject).warnings = [{ code: "motionEvidenceUnavailable", message: "No DOM motion evidence available" }];
      return env;
    }

    case "research_ui_anti_patterns":
      return successEnvelope(tool, {
        results: [{ text: "Avoid centering everything", sourceIds: ["ref-a"], count: 2 }],
      }, ["ref-a"], 1);

    case "research_ui_palettes":
      return successEnvelope(tool, {
        results: [{
          tokens: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" },
          accentHue: 220, product: "Synthetic", sourceId: "ref-a", patternType: "dashboard",
        }],
      }, ["ref-a"], 1);

    case "research_ui_techniques":
      return successEnvelope(tool, {
        results: [{ text: "Use whitespace to separate sections", source: { id: "ref-a", product: "Synthetic" } }],
      }, ["ref-a"], 1);

    case "critique_ui": {
      const env = successEnvelope(tool, {
        platform: "web",
        retrievalMode: "none",
        fallbackUsed: false,
        coverage: "full",
        summary: "Good design with minor accessibility concerns.",
        observations: ["The layout is clean."],
        recommendations: [{
          observation: "Low contrast on secondary text",
          impact: "Accessibility risk",
          recommendation: "Increase contrast to 4.5:1",
          evidence: ["evidence-screen-a"],
          basis: "visible",
        }],
        accessibilityRisks: [],
        visualSlop: [],
        motion: [],
        appliedReferences: [{ id: "ref-a", version: 1, purpose: "Similar dashboard pattern" }],
        evidenceIds: ["evidence-screen-a", "evidence-corpus-a"],
        confidence: "medium",
      }, ["ref-a"], 1);
      (env as JsonObject).evidence = [
        { id: "evidence-screen-a", kind: "screen-observation", summary: "Low contrast on secondary text.", basis: "visible" },
        { id: "evidence-corpus-a", referenceId: "ref-a", kind: "corpus-observation", summary: "Uses a sidebar layout.", basis: "visible" },
      ];
      (env as JsonObject).warnings = [{ code: "insufficientCorpusEvidence", message: "Only one corpus reference found." }];
      return env;
    }

    default: {
      const _exhaustive: never = tool;
      throw new Error(`No fixture for tool: ${_exhaustive}`);
    }
  }
}

export function makeValidError(tool: ToolName): JsonObject | null {
  const isEvidenceTool = tool === "plan_ui_direction" || tool === "create_ui_spec" || tool === "critique_ui";
  const errorEnvelope = (code: string, message: string, retryable: boolean): JsonObject => {
    const env: JsonObject = {
      tool,
      schemaVersion: "1.0",
      status: "error",
      summary: message,
      data: null,
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false, attemptedCount: 0, attemptedModes: [] },
      warnings: [],
      error: { code, message, retryable },
    };
    // Evidence tools require the evidence array even on error
    if (isEvidenceTool) env.evidence = [];
    return env;
  };

  switch (tool) {
    case "search_ui_references":
      return errorEnvelope("PROVIDER_ERROR", "Provider unavailable", true);
    case "get_ui_reference":
      return errorEnvelope("NOT_FOUND", "Entry not found", false);
    case "find_similar_ui_references":
      return errorEnvelope("NOT_FOUND", "Source entry not found", false);
    case "compare_ui_references":
      return errorEnvelope("NOT_FOUND", "All entries not found", false);
    case "plan_ui_direction":
      return errorEnvelope("PROVIDER_ERROR", "Provider unavailable", true);
    case "create_ui_spec":
      return errorEnvelope("INVALID_INPUT", "Invalid input", false);
    case "critique_ui":
      return errorEnvelope("PROVIDER_ERROR", "Provider unavailable", true);
    case "get_ui_taxonomy":
    case "browse_ui_patterns":
    case "research_ui_anti_patterns":
    case "research_ui_palettes":
    case "research_ui_techniques":
      return null; // no application errors
    default: {
      const _exhaustive: never = tool;
      throw new Error(`No error fixture for tool: ${_exhaustive}`);
    }
  }
}

export function cloneToolResult<T>(value: T): T {
  return structuredClone(value);
}
