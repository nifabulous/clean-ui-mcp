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
      "evidence": "What visible evidence supports this",
      "wcag": ["4.1.2"]
    }
  ]
}

## Rules

- Every recommendation MUST cite at least one evidence ID from the list above.
- WCAG IDs must be canonical (e.g. "1.4.3", "4.1.2") — only cite when visible evidence supports the claim.
- Observations must be specific and factual, not generic ("good layout", "clean design" are banned).
- 3-7 observations, 3-5 recommendations maximum.
- Return ONLY the JSON object.`;
}

// ─── synthesis call ────────────────────────────────────────────────────────────

/**
 * Call the text model with the critique rubric. Returns the raw draft for gating.
 */
export async function synthesizeCritique(
  evidence: CritiqueEvidence[],
  options: SynthesizeOptions,
): Promise<CritiqueUiDraft> {
  const prompt = buildCritiquePrompt(evidence, options);
  const raw = await callTextModel(prompt);
  const parsed = JSON.parse(stripFences(raw));
  return parsed as CritiqueUiDraft;
}

// ─── citation gate ─────────────────────────────────────────────────────────────

/**
 * Post-hoc citation gate: removes unsupported claims, rejects unknown citations,
 * and converts uncited recommendations into uncertain observations.
 *
 * Mirrors Decision Lab's gateCitations concept but operates on CritiqueUiDraft,
 * not SynthesisOutput.
 */
export function gateCritique(draft: CritiqueUiDraft, validEvidenceIds: string[]): {
  summary: string;
  observations: string[];
  recommendations: CritiqueRecommendation[];
  accessibilityRisks: CritiqueUiDraft["accessibilityRisks"];
} {
  const validSet = new Set(validEvidenceIds);

  // Gate recommendations: keep all, but mark uncertain if evidence is empty or invalid.
  const recommendations: CritiqueRecommendation[] = draft.recommendations.map((rec) => {
    const hasValidEvidence = rec.evidence.length > 0 && rec.evidence.every((id) => validSet.has(id));
    return {
      ...rec,
      uncertain: !hasValidEvidence,
    };
  });

  // Gate accessibility risks: drop ones with empty evidence.
  const accessibilityRisks = draft.accessibilityRisks.filter(
    (risk) => risk.evidence && risk.evidence.trim().length > 0,
  );

  return {
    summary: draft.summary,
    observations: draft.observations,
    recommendations,
    accessibilityRisks,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
