/**
 * Valid synthetic fixtures for every tool contract.
 * No corpus/private data — all IDs are synthetic.
 */
import type { ToolName } from "../tool-contracts.js";

export type JsonObject = Record<string, unknown>;

/**
 * A synthetic safe public reference — the opaque `ref-<sha256>` digest shape the
 * create_ui_spec core emits and the only shape that tool's public reference
 * positions accept. Declared here because the legacy create_ui_spec envelope
 * uses it too.
 */
export const SAFE_PUBLIC_REFERENCE = `ref-${"0123456789abcdef".repeat(4)}`;

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
  mode = "none",
  modality = "none",
): JsonObject {
  return {
    tool,
    schemaVersion: "1.0",
    status: "ok",
    summary: "Synthetic valid result",
    data,
    // create_ui_spec is the only tool with the model-lane descriptor flag; its
    // envelope carries the safe execution-state key on BOTH branches (null when
    // no model ran). Other tools' envelopes must not carry it at all.
    ...(tool === "create_ui_spec" ? { modelExecutionState: null } : {}),
    referenceIds,
    retrieval: {
      mode,
      modality,
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
      return successEnvelope(tool, { results: [refSummary("ref-a")] }, ["ref-a"], 1, "hybrid", "text");

    case "get_ui_reference":
      return successEnvelope(tool, fullRef("ref-a"), ["ref-a"], 1);

    case "find_similar_ui_references":
      return successEnvelope(tool, { results: [similarRef("ref-b")] }, ["ref-b"], 1, "vector", "text");

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
      }, ["ref-a"], 1, "hybrid", "text");
      (env as JsonObject).evidence = planEvidence;
      return env;
    }

    // NOTE: this envelope is the CORPUS-GROUNDED shape (real color/typography
    // tokens under corpus-evidence authority, sourceIds on techniques and on the
    // citedDecision) — the complement of the three deterministic-fallback
    // envelopes below. Its evidence id is response-scoped (`evidence-1`) and its
    // public reference is the safe `ref-<sha256>` digest because Task 1b's
    // structural leaf gate requires both shapes for this tool. The
    // regression proof that pre-C3 (non-response-scoped) evidence rows still
    // validate against the SHARED Evidence schema now lives on the
    // plan_ui_direction and critique_ui fixtures, which are not gated.
    case "create_ui_spec": {
      const env = successEnvelope(tool, {
        specVersion: "1.0",
        context: { productContext: "A synthetic analytics dashboard", constraints: ["WCAG AA contrast"] },
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
        techniques: [{ text: "Use 8px spacing", sourceIds: [SAFE_PUBLIC_REFERENCE] }],
        antiPatterns: [],
        unavailableDecisions: [{ field: "motion", reason: "No DOM motion evidence available" }],
        acceptanceCriteria: [{
          id: "ac1", subject: "contrast", assertion: "meets-contrast",
          expectedOutcome: "4.5:1", verifier: "axe", priority: "must",
          evidenceIds: ["evidence-1"],
        }],
        citedReferences: [SAFE_PUBLIC_REFERENCE],
        citedDecisions: [{
          id: "cd1", field: "color-primary", authority: "corpus-evidence",
          evidenceIds: ["evidence-1"], readiness: "available", sourceId: SAFE_PUBLIC_REFERENCE,
        }],
        authorityLanes: { corpusEvidence: ["evidence-1"], machineRules: [], editorialGuidance: [] },
        provenance: {
          generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0",
          sourceReferences: [SAFE_PUBLIC_REFERENCE], evidenceIds: ["evidence-1"],
        },
      }, [SAFE_PUBLIC_REFERENCE], 1);
      (env as JsonObject).evidence = [
        { id: "evidence-1", kind: "corpus-observation", summary: "Uses a 12-column grid.", basis: "visible" },
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
        retrievalMode: "vector",
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
      }, ["ref-a"], 1, "vector", "image");
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

// ---------------------------------------------------------------------------
// C3 create_ui_spec envelopes — the three retrieval states the real producer
// (src/create-ui-spec.ts) can emit. These model the actual adapter output:
// response-scoped evidence IDs (`evidence-N`), corpus observations that carry
// NO referenceId, the operator-authored recipe evidence that grounds editorial
// decisions, and safe `ref-<sha256>` public references for explicit inputs.
// ---------------------------------------------------------------------------

/** The recipe/system evidence row: operator content, no public citation. */
const recipeSystemEvidence = (id: string): JsonObject => ({
  id,
  kind: "recipe-system",
  basis: "aggregate",
  summary: "Deterministic c3-fallback-v1 recipe.",
});

/** A response-scoped corpus observation: no referenceId, ever. */
const responseScopedCorpusEvidence = (id: string): JsonObject => ({
  id,
  kind: "corpus-observation",
  basis: "visible",
  summary: "Dashboard pattern with 3 layout regions.",
});

/** An explicit public reference row: carries the safe public reference only. */
const publicReferenceEvidence = (id: string, referenceId: string): JsonObject => ({
  id,
  kind: "public-reference",
  basis: "user-supplied",
  summary: "User-supplied public reference.",
  referenceId,
});

/**
 * The deterministic fallback UiSpec: null tokens under editorial authority, the
 * recipe evidence grounding the editorial designDirection decision, and corpus
 * observations recorded in the corpusEvidence lane without grounding decisions.
 */
function c3SpecData(opts: {
  corpusEvidenceIds: string[];
  editorialLane: string[];
  citedReferences: string[];
  evidenceIds: string[];
}): JsonObject {
  return {
    specVersion: "1.0",
    context: { productContext: "A synthetic analytics dashboard", constraints: [] },
    designDirection: "A synthetic analytics dashboard",
    rejectedDefaults: [],
    layoutRegions: [{ name: "Main", type: "content", components: ["chart"], responsive: [] }],
    responsiveBehavior: [],
    componentInventory: [],
    colorTokens: null,
    colorTokenAuthority: "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
    interactions: [],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: ["Keyboard operable"],
    techniques: [],
    antiPatterns: [],
    unavailableDecisions: [
      { field: "colorTokens", reason: "No corpus color evidence was retrieved." },
      { field: "typographyTokens", reason: "No corpus typography evidence was retrieved." },
      { field: "motion", reason: "Motion guidance is model-dependent." },
    ],
    acceptanceCriteria: [{
      id: "ac-direction", subject: "designDirection", assertion: "exists",
      expectedOutcome: "The brief is restated without invention", verifier: "manual",
      priority: "must", evidenceIds: [opts.editorialLane[0]!],
      manualSteps: ["Read the design direction against the submitted brief."],
    }],
    citedReferences: opts.citedReferences,
    citedDecisions: [{
      id: "designDirection-editorial-1", field: "designDirection", authority: "editorial",
      evidenceIds: [opts.editorialLane[0]!], readiness: "available",
    }],
    authorityLanes: {
      corpusEvidence: opts.corpusEvidenceIds,
      machineRules: [],
      editorialGuidance: opts.editorialLane,
    },
    provenance: {
      generatedAt: "2026-07-15T00:00:00Z", toolVersion: "c3-fallback-v1",
      sourceReferences: opts.citedReferences, evidenceIds: opts.evidenceIds,
    },
  };
}

const MOTION_WARNING = { code: "motionEvidenceUnavailable", message: "Motion guidance is model-dependent." };

/** Automatic keyword retrieval that found matches: keyword/metadata, no fallback. */
export function makeCreateUiSpecAutomatic(): JsonObject {
  const env = successEnvelope(
    "create_ui_spec",
    c3SpecData({
      corpusEvidenceIds: ["evidence-2"],
      editorialLane: ["evidence-1"],
      citedReferences: [],
      evidenceIds: ["evidence-1", "evidence-2"],
    }),
    [], 1, "keyword", "metadata",
  );
  env.evidence = [recipeSystemEvidence("evidence-1"), responseScopedCorpusEvidence("evidence-2")];
  env.warnings = [MOTION_WARNING];
  return env;
}

/** Automatic retrieval that found nothing: structured-fallback/metadata + no-results. */
export function makeCreateUiSpecZeroResultFallback(): JsonObject {
  const env = successEnvelope(
    "create_ui_spec",
    c3SpecData({
      corpusEvidenceIds: [],
      editorialLane: ["evidence-1"],
      citedReferences: [],
      evidenceIds: ["evidence-1"],
    }),
    [], 1, "structured-fallback", "metadata",
  );
  env.retrieval = {
    mode: "structured-fallback", modality: "metadata", resultCount: 1,
    fallbackUsed: true, fallbackReason: "no-results",
    attemptedCount: 1, attemptedModes: ["keyword"],
  };
  env.evidence = [recipeSystemEvidence("evidence-1")];
  env.warnings = [
    { code: "sparseCoverage", message: "Automatic retrieval returned zero matches." },
    MOTION_WARNING,
  ];
  return env;
}

/** Explicit references: none/none with one spec artifact and safe public references. */
export function makeCreateUiSpecExplicitReferences(): JsonObject {
  const env = successEnvelope(
    "create_ui_spec",
    c3SpecData({
      corpusEvidenceIds: [],
      editorialLane: ["evidence-1", "evidence-2"],
      citedReferences: [SAFE_PUBLIC_REFERENCE],
      evidenceIds: ["evidence-1", "evidence-2"],
    }),
    [SAFE_PUBLIC_REFERENCE], 1, "none", "none",
  );
  env.evidence = [
    recipeSystemEvidence("evidence-1"),
    publicReferenceEvidence("evidence-2", SAFE_PUBLIC_REFERENCE),
  ];
  env.warnings = [MOTION_WARNING];
  return env;
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
      ...(tool === "create_ui_spec" ? { modelExecutionState: null } : {}),
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
