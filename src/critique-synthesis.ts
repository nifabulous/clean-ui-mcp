/**
 * critique-synthesis.ts — critique-specific evidence assembly, LLM synthesis,
 * and post-hoc citation gate.
 *
 * Follows Decision Lab's trust-boundary pattern (evidence assembly → LLM call →
 * gate) but uses its own prompt, evidence shape, and output contract. Does NOT
 * call assembleEvidence, synthesize, buildSynthesisPrompt, or gateCitations —
 * those are coupled to DecisionT and the comparative-rubric SynthesisOutput shape.
 */
import { callTextModel } from "./tagger.js";
import { activeProviderName, activeModelName } from "./tagger.js";
import type { CritiqueEvidence, CritiqueRecommendation } from "./critique-ui.js";
import type { RetrievalResult } from "./critique-retrieval.js";
import { isWcagCriterion } from "./wcag/registry.js";

// ─── types ────────────────────────────────────────────────────────────────────

export interface CritiqueUiDraft {
  summary: string;
  observations: string[];
  recommendations: Array<{
    observation: string;
    impact: string;
    recommendation: string;
    evidence: string[];
  }>;
  accessibilityRisks: Array<{
    element: string;
    risk: string;
    evidence: string;
    wcag: string[];
  }>;
}

export interface SynthesizeOptions {
  productContext?: string;
  platform?: string;
}

// ─── evidence assembly ─────────────────────────────────────────────────────────

/**
 * Build a stable evidence bundle from extraction facts + retrieval results.
 * Evidence IDs use the `screen:<key>` and `corpus:<entryId>` scheme so the
 * citation gate can verify every recommendation references real evidence.
 */
export function buildCritiqueEvidence(
  extraction: Record<string, unknown>,
  retrieval: RetrievalResult,
  productContext?: string,
): CritiqueEvidence[] {
  const evidence: CritiqueEvidence[] = [];

  // Screen-level evidence from the tagger extraction.
  const citableKeys = ["patternType", "layoutForm", "spacingDensity", "cornerStyle", "components", "categories", "styleTags"];
  for (const key of citableKeys) {
    const val = extraction[key];
    if (val == null) continue;
    if (typeof val === "string" && val) {
      evidence.push({ id: `screen:${key}`, source: "screen", label: key, detail: val });
    } else if (Array.isArray(val) && val.length > 0) {
      evidence.push({ id: `screen:${key}`, source: "screen", label: key, detail: val.join(", ") });
    }
  }

  // Corpus-level evidence from retrieval.
  for (const entry of retrieval.entries) {
    evidence.push({
      id: `corpus:${entry.id}`,
      source: "corpus",
      label: entry.title ?? entry.id,
      detail: entry.patternType ? `Pattern: ${entry.patternType}` : undefined,
    });
  }

  return evidence;
}

// ─── synthesis prompt ──────────────────────────────────────────────────────────

/**
 * Build the critique rubric prompt. The LLM receives ONLY:
 * - The sanitized evidence bundle (no raw model output)
 * - A bounded rubric (3-7 observations, 3-5 recommendations)
 * - The requirement to cite evidence IDs in every recommendation
 */
function buildCritiquePrompt(
  evidence: CritiqueEvidence[],
  options: SynthesizeOptions,
): string {
  const evidenceBlock = evidence
    .map((e) => `- [${e.id}] ${e.source === "screen" ? "Screenshot fact" : "Corpus example"}: ${e.label}${e.detail ? ` — ${e.detail}` : ""}`)
    .join("\n");

  return `You are a UI design critic. Analyze the screenshot evidence below and produce a grounded critique.

## Evidence

${evidenceBlock}

## Context

Product: ${options.productContext ?? "Not specified"}
Platform: ${options.platform ?? "Not specified"}

## Output format (JSON only, no markdown)

{
  "summary": "2-3 sentence overview of the design's strengths and weaknesses",
  "observations": ["3-7 specific, factual observations about the visible UI"],
  "recommendations": [
    {
      "observation": "What you see in the screenshot",
      "impact": "Why it matters for the user",
      "recommendation": "What to do about it",
      "evidence": ["screen:patternType", "corpus:entryId"]
    }
  ],
  "accessibilityRisks": [
    {
      "element": "The UI element with the risk",
      "risk": "What the accessibility risk is",
      "evidence": "A single evidence ID from the list above, such as screen:components",
      "wcag": ["4.1.2"]
    }
  ]
}

## Rules

- Every recommendation MUST cite at least one evidence ID from the list above.
- Every accessibility risk MUST set evidence to one evidence ID from the list above.
- WCAG IDs must be canonical (e.g. "1.4.3", "4.1.2") — only cite when visible evidence supports the claim.
- Observations must be specific and factual, not generic ("good layout", "clean design" are banned).
- 3-7 observations, 3-5 recommendations maximum.
- Return ONLY the JSON object.`;
}

// ─── synthesis call ────────────────────────────────────────────────────────────

/**
 * Call the text model with the critique rubric. Returns the raw draft for gating.
 * I3 fix: validates the parsed shape with defaults — a malformed LLM response
 * no longer crashes the gate with TypeError.
 */
export async function synthesizeCritique(
  evidence: CritiqueEvidence[],
  options: SynthesizeOptions,
): Promise<CritiqueUiDraft> {
  const prompt = buildCritiquePrompt(evidence, options);
  let raw = await callTextModel(prompt);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFences(raw)) as Record<string, unknown>;
  } catch {
    raw = await callTextModel(
      prompt,
      undefined,
      "Your previous response was not valid JSON. Return the complete critique as one JSON object only.",
    );
    parsed = JSON.parse(stripFences(raw)) as Record<string, unknown>;
  }
  // Defensive defaults: the LLM may omit or malform fields.
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    observations: Array.isArray(parsed.observations) ? parsed.observations.filter((s: unknown) => typeof s === "string") : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.filter(isValidRec) : [],
    accessibilityRisks: Array.isArray(parsed.accessibilityRisks) ? parsed.accessibilityRisks.filter(isValidRisk) : [],
  };
}

function isValidRec(r: unknown): r is CritiqueUiDraft["recommendations"][number] {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return typeof rec.observation === "string" && typeof rec.recommendation === "string";
}

function isValidRisk(r: unknown): r is CritiqueUiDraft["accessibilityRisks"][number] {
  if (!r || typeof r !== "object") return false;
  const risk = r as Record<string, unknown>;
  return typeof risk.element === "string" && typeof risk.risk === "string";
}

// ─── citation gate ─────────────────────────────────────────────────────────────

/**
 * Post-hoc citation gate: removes unsupported claims, rejects unknown citations,
 * and downgrades uncited recommendations to uncertain observations.
 *
 * I1 fix: recommendations with entirely fabricated evidence (no valid IDs at all)
 * are downgraded to observations rather than kept as actionable recommendations.
 * Recommendations with at least one valid evidence ID are kept; any invalid IDs
 * in their evidence list are stripped.
 */
export function gateCritique(draft: CritiqueUiDraft, validEvidenceIds: string[]): {
  summary: string;
  observations: string[];
  recommendations: CritiqueRecommendation[];
  accessibilityRisks: CritiqueUiDraft["accessibilityRisks"];
} {
  const validSet = new Set(validEvidenceIds);

  const keptRecommendations: CritiqueRecommendation[] = [];
  const downgradedObservations: string[] = [];

  for (const rec of draft.recommendations) {
    const validEvidence = rec.evidence.filter((id) => validSet.has(id));
    if (validEvidence.length > 0) {
      // Keep the recommendation with only its valid evidence IDs.
      keptRecommendations.push({ ...rec, evidence: validEvidence });
    } else {
      // I1 fix: no valid evidence → downgrade to an observation, don't keep
      // as an actionable recommendation.
      downgradedObservations.push(`${rec.observation} (uncertain — no cited evidence)`);
    }
  }

  // Gate accessibility risks: require a real evidence ID and canonical WCAG IDs.
  const accessibilityRisks = draft.accessibilityRisks.filter(
    (risk) => validSet.has(risk.evidence.trim())
      && risk.wcag.length > 0
      && risk.wcag.every((id) => isWcagCriterion(id)),
  ).map((risk) => ({
    ...risk,
    wcag: [...new Set(risk.wcag)],
  }));

  return {
    summary: draft.summary,
    observations: [...draft.observations, ...downgradedObservations],
    recommendations: keptRecommendations,
    accessibilityRisks,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
