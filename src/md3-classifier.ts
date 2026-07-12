/**
 * md3-classifier.ts — conservative multi-signal MD3 resemblance classifier.
 *
 * Scores INDEPENDENT signal categories (not raw signal count) to determine
 * whether a UI resembles Material Design 3. Returns "supported" only when
 * at least three categories match, confidence meets the threshold, and no
 * hard conflict exists.
 *
 * NEVER emits the word "compliant" — only "resemblance" / "supported" /
 * "insufficient-evidence" / "conflicting". MD3 output describes resemblance,
 * never compliance.
 */

export interface Md3EvidenceInput {
  // Color signals
  dominantColors?: string[];
  accentColor?: string | null;
  colorRoles?: Record<string, unknown> | null;
  // Type signals
  typePairing?: { display?: string | null; body?: string | null; notes?: string } | null;
  // Component signals
  components?: string[];
  // Shape/elevation signals
  cornerStyle?: string | null;
  usesShadows?: boolean | null;
  usesBorders?: boolean | null;
  spacingDensity?: string | null;
}

export type Md3Classification = "supported" | "insufficient-evidence" | "conflicting";

export interface Md3Signal {
  category: string;
  evidenceId: string;
  detail: string;
}

export interface DesignSystemClassification {
  classification: Md3Classification;
  matchedCategories: string[];
  conflictingSignals: Md3Signal[];
  evidenceIds: string[];
  confidence: number; // 0-1
}

// ─── MD3 component vocabulary ──────────────────────────────────────────────────

const MD3_COMPONENTS = new Set([
  "floating-action-button", "fab",
  "navigation-rail", "navigation-bar", "navigation-drawer",
  "top-app-bar", "app-bar",
  "bottom-navigation", "bottom-sheet",
  "snackbar",
  "chip", "filter-chip",
  "dialog",
  "segmented-button",
  // NOTE: "card" is intentionally excluded — too generic, present in every design system.
]);

// ─── signal category scorers ───────────────────────────────────────────────────

/** Category 1: Tonal surfaces — 3+ muted/light tones + accent color present. */
function scoreTonalSurfaces(input: Md3EvidenceInput): Md3Signal | null {
  const colors = input.dominantColors ?? [];
  if (colors.length < 3) return null;
  if (!input.accentColor) return null;

  // Check for muted/light tones (high lightness = near-white surfaces)
  const mutedCount = colors.filter((c) => {
    const hex = c.replace("#", "");
    if (hex.length !== 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const lightness = (r + g + b) / 3;
    return lightness > 200; // near-white surface
  }).length;

  if (mutedCount >= 2) {
    return {
      category: "tonal-surfaces",
      evidenceId: "md3:tonal-surfaces",
      detail: `${mutedCount} muted surface tones + accent ${input.accentColor}`,
    };
  }
  return null;
}

/** Category 2: Type hierarchy — display + body fonts differ (MD3 type scale). */
function scoreTypeHierarchy(input: Md3EvidenceInput): Md3Signal | null {
  if (!input.typePairing) return null;
  const { display, body } = input.typePairing;
  if (display && body && display !== body) {
    return {
      category: "type-hierarchy",
      evidenceId: "md3:type-hierarchy",
      detail: `Display: ${display}, Body: ${body}`,
    };
  }
  return null;
}

/** Category 3: Component/state — MD3-specific components present. */
function scoreComponents(input: Md3EvidenceInput): Md3Signal | null {
  const components = input.components ?? [];
  const md3Matches = components.filter((c) => MD3_COMPONENTS.has(c.toLowerCase()));
  if (md3Matches.length >= 1) {
    return {
      category: "components",
      evidenceId: "md3:components",
      detail: `MD3 components: ${md3Matches.join(", ")}`,
    };
  }
  return null;
}

/** Category 4: Shape — rounded corners + shadows (MD3 elevation). */
function scoreShape(input: Md3EvidenceInput): Md3Signal | null {
  if (input.cornerStyle === "rounded" && input.usesShadows === true) {
    return {
      category: "shape",
      evidenceId: "md3:shape",
      detail: "Rounded corners + elevation shadows",
    };
  }
  return null;
}

/** Category 5: No-border discipline — MD3 prefers tonal elevation over borders. */
function scoreNoBorderDiscipline(input: Md3EvidenceInput): Md3Signal | null {
  if (input.usesBorders === false && input.usesShadows === true && input.cornerStyle === "rounded") {
    return {
      category: "no-border-discipline",
      evidenceId: "md3:no-border",
      detail: "Shadows for elevation, no borders",
    };
  }
  return null;
}

// ─── conflict detection ────────────────────────────────────────────────────────

function detectConflicts(input: Md3EvidenceInput): Md3Signal[] {
  const conflicts: Md3Signal[] = [];
  // Hard conflict: sharp corners + no shadows = flat design, contradicts MD3 elevation
  if (input.cornerStyle === "sharp" && input.usesShadows === false) {
    conflicts.push({
      category: "shape",
      evidenceId: "md3:conflict:flat",
      detail: "Sharp corners + no shadows contradicts MD3 elevation model",
    });
  }
  // Hard conflict: borders + no shadows = bordered design, not MD3 tonal elevation
  if (input.usesBorders === true && input.usesShadows === false && input.cornerStyle !== "rounded") {
    conflicts.push({
      category: "shape",
      evidenceId: "md3:conflict:bordered",
      detail: "Borders without shadows contradicts MD3 tonal elevation",
    });
  }
  return conflicts;
}

// ─── main classifier ───────────────────────────────────────────────────────────

// C3 fix: threshold lowered from 0.7 to 0.6 so that exactly 3 of 5 categories
// (3/5 = 0.6) qualifies as "supported", matching the plan's specification
// ("Return supported only when three categories match").
const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Classify whether the evidence resembles Material Design 3.
 *
 * Returns "supported" only when:
 * 1. At least 3 independent signal categories match
 * 2. Confidence >= 0.6
 * 3. No hard conflicts exist
 *
 * Never uses the word "compliant" — this is resemblance, not conformance.
 */
export function classifyMd3Resemblance(input: Md3EvidenceInput): DesignSystemClassification {
  const scorers = [scoreTonalSurfaces, scoreTypeHierarchy, scoreComponents, scoreShape, scoreNoBorderDiscipline];
  const matched: Md3Signal[] = [];
  for (const scorer of scorers) {
    const signal = scorer(input);
    if (signal) matched.push(signal);
  }

  const conflicts = detectConflicts(input);
  const matchedCategories = matched.map((s) => s.category);
  const evidenceIds = matched.map((s) => s.evidenceId);

  // Confidence: fraction of 5 categories matched, capped at 1.0
  const confidence = Math.min(matched.length / 5, 1.0);

  let classification: Md3Classification;
  if (matched.length >= 3 && confidence >= CONFIDENCE_THRESHOLD && conflicts.length === 0) {
    classification = "supported";
  } else if (conflicts.length > 0 && matched.length >= 3) {
    classification = "conflicting";
  } else {
    classification = "insufficient-evidence";
  }

  return {
    classification,
    matchedCategories,
    conflictingSignals: conflicts,
    evidenceIds,
    confidence,
  };
}
