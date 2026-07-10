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
import { hasCritiqueKey, activeProviderName, activeModelName } from "./tagger.js";

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

/** Build the constrained comparative-synthesis prompt. */
export function buildSynthesisPrompt(decision: DecisionT, bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push("You are a product-design decision analyst. You produce a pre-launch DECISION BRIEF.");
  lines.push("");
  lines.push("## Decision context");
  lines.push(`- Title: ${decision.title}`);
  lines.push(`- Target user: ${decision.context.targetUser}`);
  lines.push(`- Business goal: ${decision.context.businessGoal}`);
  lines.push(`- Primary KPI: ${decision.context.primaryKpi}`);
  if (decision.context.platform) lines.push(`- Platform: ${decision.context.platform}`);
  if (decision.context.constraints) lines.push(`- Constraints: ${decision.context.constraints}`);
  lines.push("");
  lines.push("## Directions");
  for (const dir of decision.directions) {
    lines.push(`### ${dir.name} (id: ${dir.id})`);
    if (dir.description) lines.push(dir.description);
  }
  lines.push("");
  lines.push("## Assembled evidence (you may ONLY cite these ids)");
  lines.push("Every rubric score, perspective observation, and tradeoff MUST reference at least one evidence id from this list. Scores or observations citing any other id will be REJECTED.");
  lines.push("");
  for (const item of bundle.catalog) {
    lines.push(`- ${item.id}: ${item.description}`);
  }
  lines.push("");
  lines.push("## Required output (JSON only)");
  lines.push("Return a JSON object with this shape:");
  lines.push("{");
  lines.push('  "directionRubrics": [{ "directionId": "dir-a", "scores": [{ "dimension": "visual-hierarchy", "score": 1-5-or-null, "rationale": "...", "evidence": ["valid-id"] }] }],');
  lines.push('  "perspectives": [{ "lens": "new-user|returning-power-user|accessibility-first|growth-pm", "directionId": "dir-a", "reaction": "...", "observations": [{ "note": "...", "evidence": ["valid-id"] }], "concern": "...", "confidence": "high|medium|low", "questionForUsers": "..." }],');
  lines.push('  "experimentBrief": { "hypothesis": "...", "successMetric": "...", "guardrails": ["..."] },');
  lines.push('  "tradeoffs": [{ "description": "...", "evidence": ["valid-id"] }]');
  lines.push("}");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Score dimensions: goal-alignment, visual-hierarchy, cognitive-load, copy-clarity, consistency.");
  lines.push("- Generate one perspective per lens, per direction that warrants it.");
  lines.push("- Produce 1-3 tradeoffs.");
  lines.push("- A score of null means insufficient evidence — prefer null over guessing.");
  lines.push("- Do NOT produce a recommendation or 'winner'. This is a brief, not a verdict.");
  lines.push("- Do NOT claim statistical significance. This is pre-launch guidance.");
  return lines.join("\n");
}

export interface SynthesizeResult {
  output: SynthesisOutput;
  gateDrops: number;
  gateRetries: number;
  provider: string;
  model: string;
}

/** Call the model. Mirrors tagger.ts callModel for OpenAI-compatible shape. */
async function callSynthesisModel(prompt: string): Promise<string> {
  const model = activeModelName() ?? "gpt-4o";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
    }),
  });
  if (!resp.ok) throw new Error(`Synthesis provider returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { output_text?: string; choices?: { message?: { content?: string } }[] };
  // Support both response formats (output_text like the tagger, or choices[].message.content)
  return data.output_text ?? data.choices?.[0]?.message?.content ?? "";
}

/**
 * Run the constrained comparative synthesis with citation gating.
 * Calls the model, gates the output, retries once if any items were dropped.
 */
export async function synthesize(decision: DecisionT, bundle: EvidenceBundle): Promise<SynthesizeResult> {
  if (!hasCritiqueKey()) {
    throw new Error("No provider key set for Decision Lab synthesis. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.");
  }
  const prompt = buildSynthesisPrompt(decision, bundle);
  const provider = activeProviderName() ?? "openai";
  const model = activeModelName() ?? "unknown";

  let lastOutput: SynthesisOutput | null = null;
  let lastDrops = 0;
  let retries = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callSynthesisModel(prompt + (attempt === 1 ? "\n\nNOTE: Your previous response contained scores/observations citing evidence ids that do not exist. Re-issue using ONLY ids from the assembled evidence list." : ""));
    const parsed = parseSynthesisJSON(raw);
    if (!parsed) throw new Error("Synthesis provider returned unparseable JSON.");
    const gated = gateCitations(parsed, bundle.evidenceIds);
    lastOutput = gated.output;
    lastDrops = gated.dropped;
    if (gated.dropped === 0) break;
    retries = attempt + 1;
  }

  return { output: lastOutput!, gateDrops: lastDrops, gateRetries: retries, provider, model };
}

/** Parse the model's JSON response, tolerant of markdown fences. */
function parseSynthesisJSON(raw: string): SynthesisOutput | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned) as SynthesisOutput;
  } catch {
    return null;
  }
}

/** Render the decision brief as markdown. Mirrors renderBriefMarkdown. */
export function renderDecisionBrief(
  decision: DecisionT,
  output: SynthesisOutput,
  meta: { coverage: EvidenceCoverageT; corpusEntryCount: number },
): string {
  const lines: string[] = [];
  lines.push("# Decision brief");
  lines.push(`\n*${decision.title} — ${decision.context.businessGoal}*\n`);

  // ── Coverage label (honest, separate from confidence) ──
  lines.push(`## Corpus evidence coverage: ${meta.coverage}`);
  lines.push(`Grounded in ${meta.corpusEntryCount} corpus entr${meta.corpusEntryCount === 1 ? "y" : "ies"}.`);
  if (meta.coverage === "limited") {
    lines.push("**Limited corpus evidence** — this brief leads with screen observations and validation questions.");
  } else if (meta.coverage === "unavailable") {
    lines.push("**No corpus evidence available** for this pattern — analysis is based on screen observations only.");
  }
  lines.push("");

  // ── Per-direction rubrics ──
  for (const rubric of output.directionRubrics) {
    const direction = decision.directions.find((d) => d.id === rubric.directionId);
    lines.push(`## ${direction?.name ?? rubric.directionId}`);
    if (rubric.scores.length === 0) {
      lines.push("*No rubric dimensions could be scored from the available evidence.*\n");
      continue;
    }
    for (const score of rubric.scores) {
      const val = score.score === null ? "insufficient evidence" : `${score.score}/5`;
      lines.push(`- **${score.dimension}**: ${val} — ${score.rationale} _(evidence: ${score.evidence.join(", ")})_`);
    }
    lines.push("");
  }

  // ── Trade-offs ──
  if (output.tradeoffs.length) {
    lines.push("## Key trade-offs");
    output.tradeoffs.forEach((t, i) => lines.push(`${i + 1}. ${t.description} _(evidence: ${t.evidence.join(", ")})_`));
    lines.push("");
  }

  // ── Simulated perspectives ──
  if (output.perspectives.length) {
    lines.push("## Simulated perspectives");
    lines.push("*These are simulated reactions, not user research. Validate with real users.*\n");
    for (const p of output.perspectives) {
      const direction = decision.directions.find((d) => d.id === p.directionId);
      lines.push(`### ${lensLabel(p.lens)} — ${direction?.name ?? p.directionId}`);
      lines.push(`**Reaction:** ${p.reaction}`);
      lines.push(`**Confidence:** ${p.confidence}`);
      if (p.observations.length) {
        lines.push("**Observations:**");
        for (const obs of p.observations) lines.push(`- ${obs.note} _(evidence: ${obs.evidence.join(", ")})_`);
      }
      lines.push(`**Concern:** ${p.concern}`);
      lines.push(`**Validate with users:** ${p.questionForUsers}\n`);
    }
  }

  // ── Experiment brief ──
  lines.push("## Experiment brief");
  lines.push(`- **Hypothesis:** ${output.experimentBrief.hypothesis}`);
  lines.push(`- **Success metric:** ${output.experimentBrief.successMetric}`);
  lines.push(`- **Guardrails:** ${output.experimentBrief.guardrails.join("; ")}`);
  lines.push("");

  // ── Pre-launch caveat ──
  lines.push("---");
  lines.push("*This is a pre-launch decision brief. It predicts likely strengths, risks, and research hypotheses. It is not statistically valid A/B-test results — that requires production traffic and experiment data.*");

  return lines.join("\n");
}

function lensLabel(lens: string): string {
  const map: Record<string, string> = {
    "new-user": "New user",
    "returning-power-user": "Returning/power user",
    "accessibility-first": "Accessibility-first user",
    "growth-pm": "Growth-minded PM",
  };
  return map[lens] ?? lens;
}
