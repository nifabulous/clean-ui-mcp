// src/verify/detector-registry.ts
import type { DetectorEntry } from "./detector-types.js";
import { detect as detectAccessibility } from "./detectors/accessibility-risks.js";
import { canAffirm as affirmAccessibility } from "./detectors/accessibility-risks.js";
import { detect as detectAccent, canAffirm as affirmAccent, confidenceBand as accentBand } from "./detectors/accent-color.js";
import { detect as detectBorders, canAffirm as affirmBorders, confidenceBand as bordersBand } from "./detectors/uses-borders.js";
import { detect as detectColorRoles, canAffirm as affirmColorRoles } from "./detectors/color-roles.js";
import { detect as detectCorner, canAffirm as affirmCorner, confidenceBand as cornerBand } from "./detectors/corner-style.js";
import { detect as detectDominant } from "./detectors/dominant-colors.js";
import { detect as detectPlatform } from "./detectors/platform.js";
import { detect as detectShadows, canAffirm as affirmShadows, confidenceBand as shadowsBand } from "./detectors/uses-shadows.js";
import { detect as detectSpacing, canAffirm as affirmSpacing, confidenceBand as spacingBand } from "./detectors/spacing-density.js";

/** Exact arithmetic detectors never fire the band (confidence is 0 or 1). */
const EXACT_BAND = { low: 0.001, high: 0.999 };

/**
 * The single place a field's deterministic status is declared. The contract
 * test in detector-registry.test.ts pins TIER_BY_FIELD to this table.
 */
export const detectorRegistry: Record<string, DetectorEntry> = {
  platform: { detect: detectPlatform, category: "certifying", accuracyFloor: 1, confidenceBand: EXACT_BAND, canAffirm: () => true },
  "visual.dominantColors": { detect: detectDominant, category: "certifying", accuracyFloor: 1, confidenceBand: EXACT_BAND, canAffirm: () => true },
  "visual.usesBorders": { detect: detectBorders, category: "certifying", accuracyFloor: 0.8, confidenceBand: bordersBand, canAffirm: affirmBorders },
  "visual.usesShadows": { detect: detectShadows, category: "certifying", accuracyFloor: 0.7, confidenceBand: shadowsBand, canAffirm: affirmShadows },
  "visual.accentColor": { detect: detectAccent, category: "certifying", accuracyFloor: 0.9, confidenceBand: accentBand, canAffirm: affirmAccent },
  "visual.cornerStyle": { detect: detectCorner, category: "certifying", accuracyFloor: 0.8, confidenceBand: cornerBand, canAffirm: affirmCorner },
  "visual.spacingDensity": { detect: detectSpacing, category: "certifying", accuracyFloor: 0.8, confidenceBand: spacingBand, canAffirm: affirmSpacing },
  "visual.colorRoles": { detect: detectColorRoles, category: "contradiction-only", accuracyFloor: 0.9, confidenceBand: accentBand, canAffirm: affirmColorRoles },
  "antiPatterns.accessibilityRisks": { detect: detectAccessibility, category: "contradiction-only", accuracyFloor: 0.9, confidenceBand: accentBand, canAffirm: affirmAccessibility },
};
