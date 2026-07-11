/**
 * synthesis/render.ts — render structured critique as Markdown.
 *
 * The renderer produces the complete legacy `content[0].text` output from the
 * gated StructuredCritique. This ensures backward compatibility: a consumer
 * that reads only `content[0].text` gets the full critique, while a structured
 * consumer gets `structuredContent` matching the output schema.
 */
import type { StructuredCritiqueT } from "./contracts.js";

export function renderCritiqueMarkdown(result: StructuredCritiqueT): string {
  const lines: string[] = [];
  lines.push(`# UI Critique`);
  lines.push("");
  lines.push(`**Platform:** ${result.platform}`);
  lines.push(`**Retrieval mode:** ${result.retrievalMode}${result.fallbackUsed ? " (fallback)" : ""}`);
  lines.push(`**Evidence coverage:** ${result.coverage}`);
  lines.push(`**Confidence:** ${result.confidence}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push(result.summary);
  lines.push("");
  lines.push(`## Observations`);
  for (const obs of result.observations) {
    lines.push(`- ${obs}`);
  }
  if (result.recommendations.length > 0) {
    lines.push("");
    lines.push(`## Recommendations`);
    for (const rec of result.recommendations) {
      lines.push(`- **${rec.recommendation}**`);
      lines.push(`  - Observation: ${rec.observation}`);
      lines.push(`  - Impact: ${rec.impact}`);
      lines.push(`  - Basis: ${rec.basis}`);
      lines.push(`  - Evidence: ${rec.evidence.join(", ")}`);
    }
  }
  if (result.accessibilityRisks.length > 0) {
    lines.push("");
    lines.push(`## Accessibility Risks`);
    for (const risk of result.accessibilityRisks) {
      const wcag = risk.wcag.length > 0 ? ` (${risk.wcag.join("; ")})` : "";
      lines.push(`- **${risk.element}**: ${risk.risk}${wcag}`);
      lines.push(`  - Evidence: ${risk.evidence}`);
      lines.push(`  - Basis: ${risk.basis}`);
    }
  }
  if (result.visualSlop.length > 0) {
    lines.push("");
    lines.push(`## Visual Slop Findings`);
    for (const vs of result.visualSlop) {
      const ex = vs.exception ? ` (exception: ${vs.exception})` : "";
      lines.push(`- **${vs.pattern}** — basis: ${vs.basis}${ex}`);
      lines.push(`  - Evidence: ${vs.evidence.join(", ")}`);
    }
  }
  if (result.motion.length > 0) {
    lines.push("");
    lines.push(`## Motion Guidance`);
    for (const m of result.motion) {
      const ref = m.reference ? ` (${m.reference})` : "";
      lines.push(`- ${m.note} — basis: ${m.basis}${ref}`);
      lines.push(`  - Evidence: ${m.evidence.join(", ")}`);
    }
  }
  if (result.appliedReferences.length > 0) {
    lines.push("");
    lines.push(`## Applied References`);
    for (const ref of result.appliedReferences) {
      lines.push(`- ${ref.id} (v${ref.version}, ${ref.purpose})`);
    }
  }
  if (result.md3) {
    lines.push("");
    lines.push("## MD3 Resemblance");
    lines.push("This assesses how the UI resembles MD3; it does not establish adherence to any design system.");
    lines.push(`- Classification: ${result.md3.classification}`);
    lines.push(`- Confidence: ${result.md3.confidence}`);
    lines.push(`- Matched categories: ${result.md3.matchedCategories.join(", ") || "none"}`);
    lines.push(`- Evidence: ${result.md3.evidenceIds.join(", ") || "none"}`);
    if (result.md3.conflictingSignals.length > 0) {
      lines.push("- Conflicting signals:");
      for (const signal of result.md3.conflictingSignals) {
        lines.push(`  - ${signal.category} (${signal.evidenceId}): ${signal.detail}`);
      }
    }
  }
  return lines.join("\n");
}
