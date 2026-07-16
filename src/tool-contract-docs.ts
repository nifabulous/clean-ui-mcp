/**
 * Mechanically generates the §5.5 per-tool contract reference from TOOL_DESCRIPTORS.
 *
 * The generated block is placed between GENERATED_TOOL_CONTRACTS markers in
 * the design spec. A drift test compares the marker-delimited block against
 * renderToolContractReference() output byte-for-byte.
 */
import { TOOL_DESCRIPTORS } from "./tool-contracts.js";

/** Extract field names from a Zod object schema via Zod 4 internal shape. */
function extractFieldNames(schema: unknown): string[] {
  const zodObj = schema as { _zod?: { def?: { shape?: Record<string, unknown> } } };
  const shape = zodObj?._zod?.def?.shape;
  if (shape && typeof shape === "object") {
    return Object.keys(shape);
  }
  return [];
}

/** Extract enum values from a Zod schema that wraps an enum (possibly through object/refine layers). */
function extractEnumValues(schema: unknown): readonly string[] {
  // Try various Zod 4 internal paths for enum values
  const s = schema as Record<string, unknown>;
  // Direct enum
  const directEnum = (s as { _zod?: { def?: { values?: readonly string[] } } })?._zod?.def?.values;
  if (Array.isArray(directEnum)) return directEnum;
  // Object with code field that's an enum
  const objShape = (s as { _zod?: { def?: { shape?: { code?: { _zod?: { def?: { values?: readonly string[] } } } } } } })?._zod?.def?.shape;
  if (objShape?.code?._zod?.def?.values) return objShape.code._zod.def.values;
  // Array of objects with code field
  const arrElem = (s as { _zod?: { def?: { element?: { _zod?: { def?: { shape?: { code?: { _zod?: { def?: { values?: readonly string[] } } } } } } } } } })?._zod?.def?.element;
  if (arrElem?._zod?.def?.shape?.code?._zod?.def?.values) return arrElem._zod.def.shape.code._zod.def.values;
  return [];
}

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
    const inputFields = extractFieldNames(desc.inputSchema);
    lines.push(`| Input | ${inputFields.length > 0 ? inputFields.join(", ") : "(none)"} |`);

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
    const errorCodes = extractEnumValues(desc.errorSchema);
    lines.push(`| Errors | ${errorCodes.length > 0 ? errorCodes.join(", ") : "none"} |`);

    // Warnings
    const warningValues = extractEnumValues(desc.warningSchema);
    lines.push(`| Warnings | ${warningValues.length > 0 ? warningValues.join(", ") : "none"} |`);

    // Result count semantics
    const isRetrievalCapable = desc.retrieval.length > 1;
    let countStr: string;
    if (desc.name === "get_ui_taxonomy") countStr = "0";
    else if (isRetrievalCapable) countStr = "number of results returned";
    else if (["browse_ui_patterns", "research_ui_anti_patterns", "research_ui_palettes", "research_ui_techniques"].includes(desc.name)) countStr = "number of rows returned";
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
