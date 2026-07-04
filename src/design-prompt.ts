/**
 * design-prompt.ts — synthesize a design brief across multiple corpus entries.
 *
 * Pure functions: no I/O, no LLM calls. The corpus already contains curated
 * judgments (colorRoles, typePairing notes, voice, anti-patterns); this module
 * aggregates them into a coherent brief an LLM or human designer can act on.
 * Deterministic, free, and grounded in real entries rather than hallucinated.
 *
 * Exposed as the generate_design_prompt MCP tool, but testable in isolation.
 */
import type { CorpusEntryT } from "./schema.js";

export type BriefFramework = "brief" | "tokens";

export interface GenerateBriefInput {
  ids: string[];
  framework?: BriefFramework;
  context?: string; // optional: what you're building ("a pricing page for a fintech")
}

export interface DesignBrief {
  /** One-paragraph direction statement. */
  direction: string;
  /** The entries the brief draws from, with product + what it contributes. */
  sources: { id: string; product: string; contributes: string }[];
  /** Paste-ready color tokens, merged from entries that have colorRoles. */
  colorTokens: { canvas: string; surface: string; ink: string; muted: string; accent: string };
  /** Typography approach, synthesized from typePairing notes. */
  typography: string;
  /** Layout recommendation, from the entries' layout forms + regions. */
  layout: string;
  /** Voice / copy register, from entries that have voice data. */
  voice: string;
  /** Techniques to borrow, one per entry (the strongest steal). */
  techniques: string[];
  /** Anti-patterns to avoid — consensus across all entries. */
  avoid: string[];
  /** Raw framework the caller requested (for output shaping). */
  framework: BriefFramework;
  /** Optional context the caller supplied. */
  context?: string;
}

/** Pick the value that appears most often across entries (plurality vote). */
function plurality<T>(values: T[]): T | undefined {
  if (!values.length) return undefined;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
  return best;
}

/** The single most specific steal across an entry's list (longest = most detailed). */
function topSteal(entry: CorpusEntryT): string | undefined {
  if (!entry.whatToSteal.length) return undefined;
  return [...entry.whatToSteal].sort((a, b) => b.length - a.length)[0];
}

/**
 * Synthesize a design brief from 2-5 corpus entries. Each dimension pulls the
 * consensus (plurality) or the strongest single example — never a naive concat.
 */
export function generateBrief(entries: CorpusEntryT[], input: GenerateBriefInput): DesignBrief {
  const framework = input.framework ?? "brief";

  // ── color tokens: plurality vote per role across entries that have colorRoles.
  // Each entry's colorRoles is a complete token set; merging by plurality keeps
  // a coherent palette rather than mixing hexes from different designs.
  const withColors = entries.filter((e) => e.visual.colorRoles);
  const colorTokens = withColors.length
    ? {
        canvas:  plurality(withColors.map((e) => e.visual.colorRoles!.canvas))  ?? "#ffffff",
        surface: plurality(withColors.map((e) => e.visual.colorRoles!.surface)) ?? "#f8f8f8",
        ink:     plurality(withColors.map((e) => e.visual.colorRoles!.ink))     ?? "#111111",
        muted:   plurality(withColors.map((e) => e.visual.colorRoles!.muted))   ?? "#888888",
        accent:  plurality(withColors.map((e) => e.visual.colorRoles!.accent))  ?? "#3b82f6",
      }
    : { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" };

  // ── typography: synthesize from typePairing notes (the richest signal).
  // Dedup near-identical notes, keep the most specific.
  const typeNotes = entries
    .map((e) => e.visual.typePairing.notes)
    .filter((n): n is string => !!n && n.trim().length > 20);
  const typography = typeNotes.length
    ? [...new Set(typeNotes)].slice(0, 3).join(" ")
    : "No specific typography notes in the selected entries — choose a clear hierarchy with restrained weights.";

  // ── layout: plurality on form, plus the region structure from the entry with
  // the most detailed regions.
  const layoutForms = entries.map((e) => e.layout?.form).filter((f) => f !== undefined);
  const form = plurality(layoutForms);
  const richestLayout = entries
    .filter((e) => e.layout?.regions?.length)
    .sort((a, b) => (b.layout?.regions?.length ?? 0) - (a.layout?.regions?.length ?? 0))[0];
  const regions = richestLayout?.layout?.regions ?? [];
  const regionDesc = regions.length
    ? regions.map((r) => `${r.role} (${r.width})`).join(" → ")
    : "standard content flow";
  const layout = form
    ? `${form} layout: ${regionDesc}. Density: ${plurality(entries.map((e) => e.visual.spacingDensity)) ?? "moderate"}, corners: ${plurality(entries.map((e) => e.visual.cornerStyle)) ?? "slight-round"}.`
    : `Density: ${plurality(entries.map((e) => e.visual.spacingDensity)) ?? "moderate"}, corners: ${plurality(entries.map((e) => e.visual.cornerStyle)) ?? "slight-round"}.`;

  // ── voice: synthesize from entries with voice data.
  const voices = entries
    .map((e) => e.voice?.tone)
    .filter((t): t is string => !!t && t.trim().length > 10);
  const voice = voices.length
    ? [...new Set(voices)].slice(0, 2).join(" ")
    : "No voice data in the selected entries.";

  // ── techniques: top steal per entry.
  const techniques = entries
    .map((e) => topSteal(e))
    .filter((t): t is string => !!t);

  // ── avoid: anti-patterns, deduped by first 50 chars (lowercased) so near-
  // identical patterns collapse, ranked by consensus count. These are the
  // mistakes every selected entry explicitly rejects — the strongest signal.
  const avoidKey = (s: string) => s.toLowerCase().slice(0, 50);
  const avoidCounts = new Map<string, number>();
  for (const e of entries) {
    for (const ap of e.antiPatterns.antiPatterns) {
      const key = avoidKey(ap);
      avoidCounts.set(key, (avoidCounts.get(key) ?? 0) + 1);
    }
  }
  const seenKeys = new Set<string>();
  const deduped: string[] = [];
  for (const ap of entries.flatMap((e) => e.antiPatterns.antiPatterns)) {
    const key = avoidKey(ap);
    if (!seenKeys.has(key)) { seenKeys.add(key); deduped.push(ap); }
  }
  const avoid = deduped
    .sort((a, b) => (avoidCounts.get(avoidKey(b)) ?? 0) - (avoidCounts.get(avoidKey(a)) ?? 0))
    .slice(0, 5);

  // ── sources: what each entry contributes (its most distinctive field).
  const sources = entries.map((e) => ({
    id: e.id,
    product: e.source.productName,
    contributes: e.visual.colorRoles ? "color palette"
      : (e.visual.typePairing.notes && e.visual.typePairing.notes.length > 30) ? "typography hierarchy"
      : e.voice?.tone ? "voice & copy"
      : (e.layout?.regions?.length ?? 0) > 0 ? "layout structure"
      : "critique & technique",
  }));

  // ── direction: one paragraph tying it together.
  const products = [...new Set(entries.map((e) => e.source.productName))].slice(0, 3);
  const pattern = plurality(entries.map((e) => e.patternType));
  const contextClause = input.context ? ` for ${input.context}` : "";
  // Distill the voice into a short register phrase rather than dropping a full
  // sentence mid-paragraph (which spliced awkwardly). First clause, trimmed.
  const voiceClause = voice.split(/[.,;—]/)[0].trim().toLowerCase() || "clear, direct";
  const direction = `Build a ${pattern ?? "UI"}${contextClause} drawing from ${products.join(", ")}. ` +
    `The throughline is ${plurality(entries.map((e) => e.styleTags).flat()) ?? "restraint"}: ` +
    `${form ? `a ${form} structure` : "a clear structure"} with ${plurality(entries.map((e) => e.visual.spacingDensity)) ?? "moderate"} spacing, ` +
    `an accent reserved for interactive elements, and a ${voiceClause} voice. ` +
    `The brief below distills the concrete decisions — each grounded in a specific entry you can inspect with get_ui_example.`;

  return { direction, sources, colorTokens, typography, layout, voice, techniques, avoid, framework, context: input.context };
}

/** Render a brief as markdown (the "brief" framework). */
export function renderBriefMarkdown(brief: DesignBrief): string {
  const lines: string[] = [];
  lines.push("# Design brief");
  if (brief.context) lines.push(`\n*Context: ${brief.context}*\n`);
  lines.push(`\n${brief.direction}\n`);
  lines.push(`\n## Sources\n`);
  brief.sources.forEach((s) => lines.push(`- **${s.product}** (\`${s.id}\`) — contributes ${s.contributes}`));

  lines.push(`\n## Color tokens (paste-ready)`);
  lines.push("```css");
  lines.push(`:root {`);
  lines.push(`  --canvas:  ${brief.colorTokens.canvas};`);
  lines.push(`  --surface: ${brief.colorTokens.surface};`);
  lines.push(`  --ink:     ${brief.colorTokens.ink};`);
  lines.push(`  --muted:   ${brief.colorTokens.muted};`);
  lines.push(`  --accent:  ${brief.colorTokens.accent};`);
  lines.push(`}`);
  lines.push("```");

  lines.push(`\n## Typography`);
  lines.push(brief.typography);

  lines.push(`\n## Layout`);
  lines.push(brief.layout);

  lines.push(`\n## Voice & copy`);
  lines.push(brief.voice);

  if (brief.techniques.length) {
    lines.push(`\n## Techniques to borrow`);
    brief.techniques.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }

  if (brief.avoid.length) {
    lines.push(`\n## Avoid (anti-patterns consensus)`);
    brief.avoid.forEach((a) => lines.push(`- ${a}`));
  }
  return lines.join("\n");
}

/** Render a brief as JSON design tokens (the "tokens" framework). */
export function renderBriefTokens(brief: DesignBrief): string {
  return JSON.stringify({
    direction: brief.direction,
    context: brief.context ?? null,
    sources: brief.sources,
    tokens: {
      color: brief.colorTokens,
      spacing: brief.layout,
      typography: brief.typography,
      voice: brief.voice,
    },
    techniques: brief.techniques,
    avoid: brief.avoid,
  }, null, 2);
}

/** Dispatch to the requested framework's renderer. */
export function renderBrief(brief: DesignBrief): string {
  return brief.framework === "tokens" ? renderBriefTokens(brief) : renderBriefMarkdown(brief);
}
