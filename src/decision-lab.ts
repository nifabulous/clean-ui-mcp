/**
 * decision-lab.ts — the Decision Lab analysis engine.
 *
 * Three layers:
 * 1. assembleEvidence (pure) — flattens tagger extractions + corpus retrievals
 *    into a cited evidence bundle with stable ids.
 * 2. buildComparativeSynthesis (LLM call) — the one new model call. Constrained
 *    comparative rubric fed ONLY assembled evidence.
 * 3. gateCitations (post-hoc runtime gate) — drops rubric scores and perspective
 *    observations that don't cite assembled evidence, with one retry.
 *
 * Mirrors tagger.ts (LLM call + post-hoc gate) and design-prompt.ts (pure synthesis + rendering).
 */
import type { DecisionT, EvidenceCoverageT } from "./schema.js";

/** A screen's Pass-1 tagger extraction (the `tagging` field on DecisionScreen). */
export interface ExtractedScreen {
  extraction: Record<string, unknown>;
}

/** A retrieved corpus example for evidence grounding. */
export interface CorpusEvidenceItem {
  id: string;
  patternType?: string;
  critique?: string;
  categories?: string[];
}

/** The assembled evidence bundle passed to the synthesis prompt. */
export interface EvidenceBundle {
  /** All stable evidence ids the synthesis may cite. */
  evidenceIds: string[];
  /** Human-readable evidence catalog (id → description) for the prompt. */
  catalog: { id: string; description: string }[];
  /** The corpus items, retained for the report. */
  corpusItems: CorpusEvidenceItem[];
}

/** The fields from a tagger extraction worth citing as evidence. */
const CITABLE_EXTRACTION_KEYS = [
  "patternType", "categories", "styleTags", "components", "domainTags",
  "colorScheme", "spacingDensity", "cornerStyle", "usesShadows", "usesBorders",
  "colorRoles", "dominantColors", "accentColor",
];

/**
 * Flatten tagger extractions + corpus retrievals into a cited evidence bundle.
 * Pure — no I/O, no API calls. Each evidence item gets a stable id so the
 * synthesis and the citation gate can reference it deterministically.
 */
export function assembleEvidence(
  decision: DecisionT,
  screens: Record<string, ExtractedScreen>,
  corpus: CorpusEvidenceItem[],
): EvidenceBundle {
  const catalog: { id: string; description: string }[] = [];
  const evidenceIds: string[] = [];

  for (const direction of decision.directions) {
    for (const screen of direction.screens) {
      const extracted = screens[screen.id]?.extraction;
      if (!extracted) continue;
      for (const key of CITABLE_EXTRACTION_KEYS) {
        const value = extracted[key];
        if (value === undefined || value === null) continue;
        const isEmpty = Array.isArray(value) ? value.length === 0 : value === "";
        if (isEmpty) continue;
        const id = `${direction.id}:${screen.id}:${key}`;
        const description = formatEvidenceValue(direction.name, key, value);
        evidenceIds.push(id);
        catalog.push({ id, description });
      }
    }
  }

  const corpusItems: CorpusEvidenceItem[] = [];
  for (const item of corpus) {
    const id = `corpus:${item.id}`;
    evidenceIds.push(id);
    catalog.push({ id, description: `Corpus: ${item.id} (${item.patternType ?? "unknown"}) — ${item.critique?.slice(0, 100) ?? ""}` });
    corpusItems.push(item);
  }

  return { evidenceIds, catalog, corpusItems };
}

function formatEvidenceValue(directionName: string, key: string, value: unknown): string {
  const valStr = Array.isArray(value) ? value.join(", ") : String(value);
  return `[${directionName}] ${key}: ${valStr}`;
}

/**
 * Classify corpus evidence coverage. Shown SEPARATELY from analysis confidence,
 * per the design. Drives the honest "limited corpus evidence" labeling.
 */
export function classifyCoverage(corpusEntryCount: number): EvidenceCoverageT {
  if (corpusEntryCount >= 5) return "strong";
  if (corpusEntryCount >= 1) return "limited";
  return "unavailable";
}

/** The raw synthesis output shape (what the model returns). */
export interface SynthesisOutput {
  directionRubrics: {
    directionId: string;
    scores: {
      dimension: string;
      score: number | null;
      rationale: string;
      evidence: string[];
    }[];
  }[];
  perspectives: {
    lens: string;
    directionId: string;
    reaction: string;
    observations: { note: string; evidence: string[] }[];
    concern: string;
    confidence: string;
    questionForUsers: string;
  }[];
  experimentBrief: { hypothesis: string; successMetric: string; guardrails: string[] };
  tradeoffs: { description: string; evidence: string[] }[];
}

export interface GateResult {
  output: SynthesisOutput;
  /** Number of scores/observations/tradeoffs dropped for uncited evidence. */
  dropped: number;
}

/**
 * Post-hoc citation gate. Drops any rubric score, perspective observation, or
 * tradeoff whose evidence array references an id not in the assembled evidence
 * bundle. Mirrors the tagger's banned-phrase gate and sanitizeAccessibilityRisks
 * evidence gate — enforce, don't just measure.
 *
 * Returns the cleaned output + a dropped count (for retry decisions and logging).
 */
export function gateCitations(output: SynthesisOutput, validEvidenceIds: string[]): GateResult {
  const valid = new Set(validEvidenceIds);
  let dropped = 0;

  const directionRubrics = output.directionRubrics.map((rubric) => ({
    directionId: rubric.directionId,
    scores: rubric.scores.filter((score) => {
      const ok = score.evidence.length > 0 && score.evidence.every((e) => valid.has(e));
      if (!ok) dropped++;
      return ok;
    }),
  }));

  const perspectives = output.perspectives.map((p) => {
    const observations = p.observations.filter((obs) => {
      const ok = obs.evidence.length > 0 && obs.evidence.every((e) => valid.has(e));
      if (!ok) dropped++;
      return ok;
    });
    return { ...p, observations };
  });

  const tradeoffs = output.tradeoffs.filter((t) => {
    const ok = t.evidence.length > 0 && t.evidence.every((e) => valid.has(e));
    if (!ok) dropped++;
    return ok;
  });

  return { output: { directionRubrics, perspectives, experimentBrief: output.experimentBrief, tradeoffs }, dropped };
}
