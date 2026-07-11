/**
 * synthesis/context.ts — three authority-separated input lanes for critique synthesis.
 *
 * The critique prompt receives three distinct sections:
 * - Evidence: screenshot-derived facts + corpus entries (citable as screen:* and corpus:*)
 * - Rules: canonical machine rules from generated.ts (banned phrases, detectors)
 * - Guidance: editorial reference material (not citable as evidence)
 *
 * This separation enforces the trust boundary: only evidence IDs support
 * observations; editorial guidance supports recommendations but never facts.
 */
import type { CritiqueEvidence } from "../critique-ui.js";
import type { RetrievalResult } from "../critique-retrieval.js";
import { BANNED_PHRASES, VAGUE_PHRASES, UNLABELED_CONTROL_RISK, PIXEL_MEASUREMENT, EXEMPTION_PATTERNS, REFERENCE_METADATA } from "../references/generated.js";

// ─── types ────────────────────────────────────────────────────────────────────

export interface MachineRulesLane {
  bannedPhrases: readonly string[];
  vaguePhrases: readonly string[];
  detectors: {
    unlabeledControl: string; // regex source
    pixelMeasurement: string;
    exemptions: { domGroundTruth: string; contrastClause: string; positiveLabelPairing: string };
  };
}

export interface GuidanceLane {
  id: string;
  label: string;
  version: number;
  purpose: string;
}

export interface SynthesisContext {
  evidence: CritiqueEvidence[];
  rules: MachineRulesLane;
  guidance: GuidanceLane[];
  /** All valid evidence IDs — used by the citation gate */
  evidenceIds: string[];
}

export interface BuildContextInput {
  extraction: Record<string, unknown>;
  retrieval: RetrievalResult;
  productContext?: string;
  /** Optional DOM motion signals — becomes dom:motion:* evidence. */
  motion?: Array<{
    selector: string;
    property: string;
    durationMs: number;
    delayMs: number;
    iterationCount?: string;
    timingFunction?: string;
  }> | null;
}

// ─── evidence constants ───────────────────────────────────────────────────────

/** Citable extraction keys → evidence IDs (the original screen: facts). */
const CITABLE_KEYS = [
  "patternType", "categories", "styleTags", "components",
  "domainTags", "layoutForm", "spacingDensity", "cornerStyle",
] as const;

/** Max items per array detail (prevents prompt bloat from long component lists). */
const MAX_ARRAY_DETAIL = 10;

// ─── visual evidence registration ─────────────────────────────────────────────

export interface VisualEvidenceInput {
  dominantColors?: string[] | null;
  accentColor?: string | null;
  colorRoles?: Record<string, unknown> | null;
  usesShadows?: boolean | null;
  usesBorders?: boolean | null;
  typePairing?: Record<string, unknown> | null;
  spacingDensity?: string | null;
  cornerStyle?: string | null;
}

/**
 * Register visual evidence from the tagger's extraction.
 * Produces `screen:visual:*` evidence IDs for color, shadow, border, and type
 * facts. Only non-null fields are included.
 */
export function registerVisualEvidence(input: VisualEvidenceInput): CritiqueEvidence[] {
  const evidence: CritiqueEvidence[] = [];

  if (input.dominantColors && Array.isArray(input.dominantColors) && input.dominantColors.length > 0) {
    evidence.push({
      id: "screen:visual:colors",
      source: "screen",
      label: "Dominant colors",
      detail: input.dominantColors.slice(0, MAX_ARRAY_DETAIL).join(", "),
    });
  }

  if (input.accentColor) {
    evidence.push({
      id: "screen:visual:accentColor",
      source: "screen",
      label: "Accent color",
      detail: String(input.accentColor),
    });
  }

  if (input.colorRoles && typeof input.colorRoles === "object") {
    // I8 fix: only stringify primitive values — skip objects to avoid [object Object]
    const roles = Object.entries(input.colorRoles)
      .filter(([, v]) => v != null && typeof v !== "object");
    if (roles.length > 0) {
      evidence.push({
        id: "screen:visual:colorRoles",
        source: "screen",
        label: "Color roles",
        detail: roles.map(([k, v]) => `${k}=${v}`).join(", "),
      });
    }
  }

  if (input.usesShadows != null) {
    evidence.push({
      id: "screen:visual:usesShadows",
      source: "screen",
      label: "Uses shadows",
      detail: String(input.usesShadows),
    });
  }

  if (input.usesBorders != null) {
    evidence.push({
      id: "screen:visual:usesBorders",
      source: "screen",
      label: "Uses borders",
      detail: String(input.usesBorders),
    });
  }

  if (input.typePairing && typeof input.typePairing === "object") {
    const notes = (input.typePairing as Record<string, unknown>).notes;
    if (typeof notes === "string" && notes) {
      evidence.push({
        id: "screen:visual:typePairing",
        source: "screen",
        label: "Type pairing",
        detail: notes,
      });
    }
  }

  return evidence;
}

// ─── rules lane ───────────────────────────────────────────────────────────────

function buildRulesLane(): MachineRulesLane {
  return {
    bannedPhrases: BANNED_PHRASES,
    vaguePhrases: VAGUE_PHRASES,
    detectors: {
      unlabeledControl: UNLABELED_CONTROL_RISK.source,
      pixelMeasurement: PIXEL_MEASUREMENT.source,
      exemptions: {
        domGroundTruth: EXEMPTION_PATTERNS.domGroundTruth.source,
        contrastClause: EXEMPTION_PATTERNS.contrastClause.source,
        positiveLabelPairing: EXEMPTION_PATTERNS.positiveLabelPairing.source,
      },
    },
  };
}

// ─── guidance lane ────────────────────────────────────────────────────────────

function buildGuidanceLane(): GuidanceLane[] {
  // Generated at build time from the validated reference manifest; production
  // requests never read repository files or silently fall back to stale values.
  return REFERENCE_METADATA.map((reference) => ({
    id: `ref:${reference.id}`,
    label: reference.id,
    version: reference.version,
    purpose: reference.purposes[0] ?? "general",
  }));
}

// ─── main builder ─────────────────────────────────────────────────────────────

/**
 * Build the synthesis context: three authority-separated lanes plus a flat
 * evidence ID list for the citation gate.
 */
export function buildSynthesisContext(input: BuildContextInput): SynthesisContext {
  const { extraction, retrieval } = input;
  const evidence: CritiqueEvidence[] = [];

  // ── Screen-level evidence from extraction facts ──────────────────────────
  for (const key of CITABLE_KEYS) {
    const val = extraction[key];
    if (val == null) continue;
    if (typeof val === "string" && val) {
      evidence.push({ id: `screen:${key}`, source: "screen", label: key, detail: val });
    } else if (typeof val === "boolean") {
      evidence.push({ id: `screen:${key}`, source: "screen", label: key, detail: String(val) });
    } else if (Array.isArray(val) && val.length > 0) {
      const detail = val.slice(0, MAX_ARRAY_DETAIL).join(", ");
      evidence.push({ id: `screen:${key}`, source: "screen", label: key, detail });
    }
  }

  // ── Visual evidence (colors, shadows, borders, type pairing) ──────────────
  const visual = registerVisualEvidence({
    dominantColors: extraction.dominantColors as string[] | undefined,
    accentColor: extraction.accentColor as string | null | undefined,
    colorRoles: extraction.colorRoles as Record<string, unknown> | null | undefined,
    usesShadows: extraction.usesShadows as boolean | null | undefined,
    usesBorders: extraction.usesBorders as boolean | null | undefined,
    typePairing: extraction.typePairing as Record<string, unknown> | null | undefined,
    spacingDensity: extraction.spacingDensity as string | null | undefined,
    cornerStyle: extraction.cornerStyle as string | null | undefined,
  });
  evidence.push(...visual);

  // ── Corpus-level evidence from retrieval ──────────────────────────────────
  for (const entry of retrieval.entries) {
    evidence.push({
      id: `corpus:${entry.id}`,
      source: "corpus",
      label: entry.title ?? entry.id,
      detail: entry.patternType ? `Pattern: ${entry.patternType}` : undefined,
    });
  }

  // ── DOM motion evidence (Task 9) ───────────────────────────────────────────
  // DOM motion signals become dom:motion:<index> evidence. These are factual
  // declarations (the stylesheet says "transition: 0.3s"), NOT runtime proof
  // that an animation ran. The prompt and gate enforce this distinction.
  if (input.motion && Array.isArray(input.motion)) {
    for (let i = 0; i < Math.min(input.motion.length, MAX_ARRAY_DETAIL); i++) {
      const sig = input.motion[i];
      evidence.push({
        id: `dom:motion:${i}`,
        source: "dom",
        label: `Motion: ${sig.selector} ${sig.property}`,
        detail: `${sig.durationMs}ms${sig.delayMs ? ` (+${sig.delayMs}ms delay)` : ""}${sig.iterationCount ? ` × ${sig.iterationCount}` : ""}`,
      });
    }
  }

  return {
    evidence,
    rules: buildRulesLane(),
    guidance: buildGuidanceLane(),
    evidenceIds: evidence.map((e) => e.id),
  };
}
