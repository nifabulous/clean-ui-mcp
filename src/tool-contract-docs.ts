/**
 * Mechanically generates the §5.5 per-tool contract reference from TOOL_DESCRIPTORS.
 *
 * The generated block is placed between GENERATED_TOOL_CONTRACTS markers in
 * the design spec. A drift test compares the marker-delimited block against
 * renderToolContractReference() output byte-for-byte.
 */
import { TOOL_DESCRIPTORS } from "./tool-contracts.js";

/**
 * Render the complete §5.5 contract reference block for all 12 tools.
 * Output is deterministic and stable across runs for the same descriptors.
 */
export function renderToolContractReference(): string {
  const lines: string[] = [];

  for (const desc of TOOL_DESCRIPTORS) {
    lines.push(`#### \`${desc.name}\``);
    lines.push("");
    lines.push("| Aspect | Contract |");
    lines.push("|---|---|");

    // Input
    const inputFields: string[] = [];
    const inputShape = (desc.inputSchema as unknown as { _zod?: { propValues?: Record<string, unknown> } })?._zod?.propValues;
    if (inputShape && typeof inputShape === "object") {
      for (const [key, _val] of Object.entries(inputShape)) {
        inputFields.push(key);
      }
    }
    lines.push(`| Input | ${inputFields.length > 0 ? inputFields.join(", ") + "?" : "(none)"} |`);

    // Retrieval
    const retrievalStr = desc.retrieval.map((r: { mode: string; modality: string; fallbackReasons?: readonly string[] }) => {
      const base = `${r.mode}/${r.modality}`;
      if (r.fallbackReasons && r.fallbackReasons.length > 0) {
        return `${base} (reasons: ${r.fallbackReasons.join(", ")})`;
      }
      return base;
    }).join("; ");
    lines.push(`| Retrieval | ${retrievalStr} |`);

    // Evidence
    lines.push(`| Evidence | ${desc.hasEvidence ? "required (plan/spec/critique)" : "forbidden"} (${desc.evidenceKinds.length > 0 ? desc.evidenceKinds.join(", ") : "none"}) |`);

    // Errors
    const errorSchema = desc.errorSchema as unknown as { _zod?: { propValues?: { code?: { _zod?: { values?: readonly string[] } } } } };
    const errorCodes = errorSchema?._zod?.propValues?.code?._zod?.values ?? [];
    lines.push(`| Errors | ${errorCodes.length > 0 ? errorCodes.join(", ") : "none"} |`);

    // Warnings
    const warningSchema = desc.warningSchema as unknown as { _zod?: { propValues?: { _zod?: { values?: readonly string[] } } } };
    const warningValues = (desc.warningSchema as unknown as { _zod?: { propValues?: { code?: { _zod?: { values?: readonly string[] } } } } })?._zod?.propValues?.code?._zod?.values ?? [];
    void warningSchema;
    lines.push(`| Warnings | ${warningValues.length > 0 ? warningValues.join(", ") : "none"} |`);

    // Result count semantics
    const isPrimary = desc.retrieval.length > 1;
    let countStr: string;
    if (desc.name === "get_ui_taxonomy") countStr = "0";
    else if (isPrimary) countStr = "number of results returned";
    else countStr = "1 when artifact exists, 0 otherwise";
    lines.push(`| resultCount | ${countStr} |`);

    // Reference IDs
    lines.push(`| referenceIds | unique stable IDs exactly matching data IDs |`);

    // Legacy names
    lines.push(`| Legacy names | ${desc.legacyNames.length > 0 ? desc.legacyNames.join(", ") : "(none — critique_ui unchanged)"} |`);

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extract the generated block from the spec markdown file.
 */
export function extractGeneratedBlock(markdown: string): string | null {
  const start = markdown.indexOf("<!-- GENERATED_TOOL_CONTRACTS_START -->");
  const end = markdown.indexOf("<!-- GENERATED_TOOL_CONTRACTS_END -->");
  if (start === -1 || end === -1) return null;
  return markdown.slice(start + "<!-- GENERATED_TOOL_CONTRACTS_START -->".length, end).trim();
}
