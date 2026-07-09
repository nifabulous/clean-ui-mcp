/**
 * Deterministic tagger contract fixtures.
 *
 * These are CANNED model-output blobs (parsed JSON) paired with the expected
 * sanitized result. They exercise the sanitizer's contract — the pure,
 * provider-independent layer that every model output must pass through.
 *
 * The contract is the baseline: it must hold regardless of provider/model.
 * The WCAG prompt change must not regress any of these accept/reject outcomes.
 * New provider-matrix evaluation (Promptfoo) layers on top of THIS contract.
 */

export interface ContractFixture {
  /** Short name for the test (shown in failure output). */
  name: string;
  /** Canned raw model output (as if JSON.parse'd from a provider response). */
  input: Record<string, unknown>;
  /** Platform for component/layout filtering (undefined = no filtering). */
  platform?: "web" | "mobile" | "tablet";
  /** Assertions on the sanitized output. Omit a field to skip checking it. */
  expect: {
    categories?: string[];
    styleTags?: string[];
    components?: string[];
    /** Expected accessibility risks after sanitization. */
    accessibilityRisks?: Array<{
      element?: string;
      risk?: string;
      confidence?: string;
      wcag?: string[];
    }>;
    /** Exact count of accessibility risks (shortcut for expecting []). */
    accessibilityRiskCount?: number;
  };
}

/**
 * Fixtures covering the accessibility-risk sanitization contract — the area
 * most affected by the WCAG canonical-ID change. Each names a real failure
 * class the sanitizer must reject, or a valid case it must accept.
 */
export const ACCESSIBILITY_RISK_FIXTURES: ContractFixture[] = [
  {
    name: "accepts valid risk with canonical WCAG array",
    input: {
      draftAccessibilityRisks: [{
        element: "payment status dot",
        risk: "State is communicated by color alone.",
        evidence: "small red/green dots beside Paid and Failed rows, no text status label",
        confidence: "visible",
        wcag: ["1.4.1"],
      }],
    },
    expect: {
      accessibilityRisks: [{ element: "payment status dot", confidence: "visible", wcag: ["1.4.1"] }],
      accessibilityRiskCount: 1,
    },
  },
  {
    name: "drops title-bearing citation from live model output",
    input: {
      draftAccessibilityRisks: [{
        element: "status chips",
        risk: "Color-only differentiation invisible to color-blind users.",
        evidence: "red/green dots beside Paid and Failed rows with no text status label",
        confidence: "visible",
        // The old format: model emits a title-bearing string instead of an array.
        wcag: "1.4.1 Use of Color",
      }],
    },
    expect: {
      accessibilityRiskCount: 0,
    },
  },
  {
    name: "drops comma-joined citations from live model output",
    input: {
      draftAccessibilityRisks: [{
        element: "status indicators",
        risk: "Color-only status and focus-order ambiguity.",
        evidence: "colored dots beside Paid and Failed rows; the tab sequence skips the filter row",
        confidence: "visible",
        wcag: "1.4.1 Use of Color, 2.4.7 Focus Visible",
      }],
    },
    expect: {
      accessibilityRiskCount: 0,
    },
  },
  {
    name: "DROPS risk with no WCAG citation (the new gate)",
    input: {
      draftAccessibilityRisks: [{
        element: "sidebar",
        risk: "Icon-only controls may lack accessible names for screen reader users.",
        evidence: "left sidebar icons with no visible text labels beside them",
        confidence: "inferred",
        // No wcag field — must be dropped under the new canonical-ID requirement.
      }],
    },
    expect: { accessibilityRiskCount: 0 },
  },
  {
    name: "DROPS risk with invalid (non-registry) WCAG ID",
    input: {
      draftAccessibilityRisks: [{
        element: "contrast text",
        risk: "Low contrast on secondary labels.",
        evidence: "muted gray text on white background that looks faint",
        confidence: "inferred",
        wcag: ["9.9.9"], // does not exist in WCAG 2.2
      }],
    },
    expect: { accessibilityRiskCount: 0 },
  },
  {
    name: "drops a risk with any invalid WCAG ID",
    input: {
      draftAccessibilityRisks: [
        {
          element: "status dot",
          risk: "Color is the only visible status channel.",
          evidence: "red/green dots beside Paid and Failed rows with no text label",
          confidence: "visible",
          wcag: ["1.4.1", "9.9.9"], // a constrained live field rejects the entire mixed array
        },
      ],
    },
    expect: { accessibilityRiskCount: 0 },
  },
  {
    name: "DROPS contrast (1.4.3) risk without DOM ground truth",
    input: {
      draftAccessibilityRisks: [{
        element: "secondary text",
        risk: "Low contrast fails WCAG.",
        evidence: "muted gray labels that appear faint against the white canvas",
        confidence: "inferred",
        wcag: ["1.4.3"],
      }],
    },
    expect: { accessibilityRiskCount: 0 },
  },
  {
    name: "keeps contrast (1.4.3) risk WITH DOM ground truth",
    input: {
      draftAccessibilityRisks: [{
        element: "secondary text",
        risk: "Low contrast fails WCAG.",
        evidence: "contrastRatio 2.8:1 computed from the DOM, below the 4.5:1 threshold",
        confidence: "inferred",
        wcag: ["1.4.3"],
      }],
    },
    expect: {
      accessibilityRisks: [{ wcag: ["1.4.3"] }],
      accessibilityRiskCount: 1,
    },
  },
  {
    name: "DROPS icon-only / absence-of-label risks regardless of WCAG",
    input: {
      draftAccessibilityRisks: [{
        element: "sidebar icons",
        risk: "Icon-only controls may lack accessible names.",
        evidence: "the sidebar contains icon buttons with no visible text labels",
        confidence: "visible",
        wcag: ["1.1.1"],
      }],
    },
    expect: { accessibilityRiskCount: 0 },
  },
  {
    name: "downgrades dom-grounded confidence to inferred",
    input: {
      draftAccessibilityRisks: [{
        element: "status chips",
        risk: "Color-only differentiation invisible to color-blind users.",
        evidence: "red/green dots beside Paid and Failed rows with no text status label",
        confidence: "dom-grounded",
        wcag: ["1.4.1"],
      }],
    },
    expect: {
      accessibilityRisks: [{ confidence: "inferred", wcag: ["1.4.1"] }],
      accessibilityRiskCount: 1,
    },
  },
  {
    name: "caps risks at 2 (quota gate)",
    input: {
      draftAccessibilityRisks: [1, 2, 3].map((n) => ({
        element: `visible control ${n}`,
        risk: `Risk ${n} with enough specific detail for validation.`,
        evidence: `top-right region ${n} with visible control and label`,
        confidence: "visible",
        wcag: ["1.4.1"],
      })),
    },
    expect: { accessibilityRiskCount: 2 },
  },
];
