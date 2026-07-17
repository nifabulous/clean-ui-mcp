/**
 * Mechanically generates the §5.5 per-tool contract reference from TOOL_DESCRIPTORS.
 *
 * The generated block is placed between GENERATED_TOOL_CONTRACTS markers in
 * the design spec. A drift test compares the marker-delimited block against
 * renderToolContractReference() output byte-for-byte.
 */
import { TOOL_DESCRIPTORS, ERROR_RETRYABLE } from "./tool-contracts.js";
import { z, type ZodType } from "zod";

/**
 * Extract the `code` enum values from a schema. Errors and warnings are both
 * object/array schemas whose `code` field is a Zod enum. Zod 4 stores enum
 * values at `_zod.def.entries` (an object map like `{NOT_FOUND:"NOT_FOUND"}`);
 * older/other forms use `_zod.def.values` (an array). We handle both, walking
 * through object and array element wrappers to reach the `code` field.
 */
function extractEnumValues(schema: unknown): readonly string[] {
  const s = schema as { _zod?: { def?: Record<string, unknown> } };

  // Helper: given the `code` field's _zod.def, pull values from entries (Zod 4) or values (array).
  const codesFromDef = (codeDef: unknown): readonly string[] => {
    const def = codeDef as { entries?: Record<string, unknown>; values?: readonly string[] } | undefined;
    // Zod 4 enum form: { entries: { NOT_FOUND: "NOT_FOUND", ... } }.
    // Guard against arrays (typeof [] === "object") so they fall through to `values`.
    if (def?.entries && typeof def.entries === "object" && !Array.isArray(def.entries)) {
      return Object.keys(def.entries);
    }
    // Array form (older/alternate): { values: ["NOT_FOUND", ...] }
    if (Array.isArray(def?.values)) return def.values!;
    return [];
  };

  // 1. Direct enum schema (no object wrapper).
  const directEntries = s?._zod?.def?.entries;
  if (directEntries && typeof directEntries === "object" && !Array.isArray(directEntries)) return Object.keys(directEntries);
  const directValues = s?._zod?.def?.values;
  if (Array.isArray(directValues)) return directValues;

  // 2. Object schema with a `code` field (error schemas).
  const objShape = (s?._zod?.def?.shape) as { code?: { _zod?: { def?: unknown } } } | undefined;
  if (objShape?.code?._zod?.def) {
    const codes = codesFromDef(objShape.code._zod.def);
    if (codes.length > 0) return codes;
  }

  // 3. Array of objects with a `code` field (warning schemas).
  const arrElem = (s?._zod?.def?.element) as { _zod?: { def?: { shape?: { code?: { _zod?: { def?: unknown } } } } } } | undefined;
  const arrCodeDef = arrElem?._zod?.def?.shape?.code?._zod?.def;
  if (arrCodeDef) {
    const codes = codesFromDef(arrCodeDef);
    if (codes.length > 0) return codes;
  }

  return [];
}

/**
 * Derive the Input contract row from the Zod input schema via the public
 * `z.toJSONSchema` API. This replaces the handwritten `contractDocs.input`
 * prose with mechanically-derived field names, optionality, defaults, and
 * bounds — so a schema change is reflected in the docs automatically and the
 * drift test catches any divergence.
 *
 * Format: `query?, category, styleTag?, patternType?, minQuality (1-5)?, ...`
 *   - `?` suffix if the field is optional (not in `required`)
 *   - `(default X)` if the field has a default value
 *   - `(min-max)` if the field has numeric bounds
 */
function deriveInputRow(inputSchema: ZodType): string {
  const jsonSchema = z.toJSONSchema(inputSchema as unknown as Parameters<typeof z.toJSONSchema>[0]) as {
    properties?: Record<string, {
      default?: unknown;
      minimum?: number;
      maximum?: number;
    }>;
    required?: string[];
  };
  const props = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);
  const parts: string[] = [];
  for (const [name, def] of Object.entries(props)) {
    let part = name;
    if (!required.has(name)) part += "?";
    if (def.minimum !== undefined && def.maximum !== undefined) {
      part += ` (${def.minimum}-${def.maximum})`;
    }
    if (def.default !== undefined) {
      part += `, default ${JSON.stringify(def.default)}`;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join(", ") : "(none)";
}

/**
 * Derive the Success data field names from the Zod data schema. The top-level
 * property keys come from z.toJSONSchema; the per-field shape prose (e.g.
 * "each with id, title, product...") stays in contractDocs.successData as
 * supplementary description Zod can't express.
 */
function deriveSuccessDataFields(dataSchema: ZodType): string {
  const jsonSchema = z.toJSONSchema(dataSchema as unknown as Parameters<typeof z.toJSONSchema>[0]) as {
    properties?: Record<string, unknown>;
  };
  const fields = Object.keys(jsonSchema.properties ?? {});
  return fields.length > 0 ? fields.join(", ") : "(none)";
}

/**
 * Render the complete §5.5 contract reference block for all 12 tools.
 *
 * Row order per tool (authoritative — the drift test locks this byte-for-byte):
 *   Input, Success data, Empty, Partial, Errors, Warnings,
 *   Retrieval, Evidence, resultCount, referenceIds, Legacy names.
 *
 * Prose rows come from `desc.contractDocs`. Errors/Warnings/Retrieval/Evidence
 * are auto-derived from the descriptor schemas. Output is deterministic.
 */
export function renderToolContractReference(): string {
  const lines: string[] = [];

  for (const desc of TOOL_DESCRIPTORS) {
    lines.push(`#### \`${desc.name}\``);
    lines.push("");
    lines.push("| Aspect | Contract |");
    lines.push("|---|---|");

    // Input — derived from the Zod schema via z.toJSONSchema (field names,
    // optionality, defaults, bounds). No longer handwritten prose.
    lines.push(`| Input | ${deriveInputRow(desc.inputSchema)} |`);

    // Success data — derived field names + supplementary prose from contractDocs
    const successFields = deriveSuccessDataFields(desc.dataSchema);
    lines.push(`| Success data | ${successFields} — ${desc.contractDocs.successData} |`);

    // Empty (prose)
    lines.push(`| Empty | ${desc.contractDocs.empty} |`);

    // Partial (prose)
    lines.push(`| Partial | ${desc.contractDocs.partial} |`);

    // Errors — derived from desc.errorCodes (the type-level source) + ERROR_RETRYABLE.
    // NOT extractEnumValues(desc.errorSchema): multi-code error schemas are z.union
    // which extractEnumValues can't walk, so it would return [] and render "none"
    // for tools like search/similar/critique. desc.errorCodes is the authoritative
    // tuple the descriptor declares; rendering from it avoids Zod internals.
    const errorCodes = desc.errorCodes as readonly string[];
    const errorsStr = errorCodes.length > 0
      ? errorCodes.map(code => {
          const retryable = ERROR_RETRYABLE[code];
          const tag = retryable === true ? "retryable" : retryable === false ? "non-retryable" : "retryability unknown";
          return `${code} (${tag})`;
        }).join(", ")
      : "none";
    lines.push(`| Errors | ${errorsStr} |`);

    // Warnings — auto-derived codes
    const warningValues = extractEnumValues(desc.warningSchema);
    lines.push(`| Warnings | ${warningValues.length > 0 ? warningValues.join(", ") : "none"} |`);

    // Retrieval — auto-derived
    const retrievalStr = desc.retrieval.map((r: { mode: string; modality: string; fallbackReasons?: readonly string[] }) => {
      const base = `${r.mode}/${r.modality}`;
      if (r.fallbackReasons && r.fallbackReasons.length > 0) {
        return `${base} (reasons: ${r.fallbackReasons.join(", ")})`;
      }
      return base;
    }).join("; ");
    lines.push(`| Retrieval | ${retrievalStr} |`);

    // Evidence — auto-derived
    lines.push(`| Evidence | ${desc.hasEvidence ? "required (plan/spec/critique)" : "forbidden"} (${desc.evidenceKinds.length > 0 ? desc.evidenceKinds.join(", ") : "none"}) |`);

    // resultCount (prose)
    lines.push(`| resultCount | ${desc.contractDocs.resultCount} |`);

    // referenceIds (prose)
    lines.push(`| referenceIds | ${desc.contractDocs.referenceIds} |`);

    // Legacy names — auto-derived
    lines.push(`| Legacy names | ${desc.legacyNames.length > 0 ? desc.legacyNames.join(", ") : "(none — critique_ui unchanged)"} |`);

    // Blank separator between tools (also after the last; trimmed below).
    lines.push("");
  }

  // Join and strip the single trailing blank line so the block has no
  // dangling newline — this keeps it byte-stable against extractGeneratedBlock,
  // which trims the marker-delimited region.
  //
  // Trim contract: extractGeneratedBlock() uses `.trim()` (strips both ends)
  // while this renderer uses `.trimEnd()` (trailing only). The two stay
  // byte-equal ONLY because the renderer emits no leading whitespace. If a
  // future change ever introduces leading whitespace/newline, the extractor's
  // leading `.trim()` would mask it and the drift gate would pass while the
  // rendered spec diverged — so keep this output leading-whitespace-free.
  return lines.join("\n").trimEnd();
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
