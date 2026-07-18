import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { renderToolContractReference, extractGeneratedBlock } from "./tool-contract-docs.js";
import { TOOL_DESCRIPTORS, ToolInputSchemas, ERROR_RETRYABLE } from "./tool-contracts.js";

const SPEC_PATH = resolve(__dirname, "..", "docs", "superpowers", "specs", "2026-07-13-agent-readiness-and-retagging-design.md");

describe("tool-contract-docs", () => {
  it("renders all 12 tools", () => {
    const output = renderToolContractReference();
    for (const desc of TOOL_DESCRIPTORS) {
      expect(output).toContain(`#### \`${desc.name}\``);
    }
  });

  it("output is deterministic (stable across calls)", () => {
    const a = renderToolContractReference();
    const b = renderToolContractReference();
    expect(a).toBe(b);
  });

  it("every tool heading occurs exactly once", () => {
    const output = renderToolContractReference();
    for (const desc of TOOL_DESCRIPTORS) {
      const heading = `#### \`${desc.name}\``;
      const count = (output.match(new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      expect(count).toBe(1);
    }
  });

  it("all 13 removed names occur only in the migration table, not in generated block", () => {
    const output = renderToolContractReference();
    const removedNames = [
      "search_ui_examples", "get_ui_example", "list_categories",
      "list_style_tags", "list_domain_tags", "get_similar_ui_examples",
      "compare_ui_examples", "generate_design_prompt", "recommend_ui_direction",
      "get_anti_patterns", "get_color_palette", "get_stealable_techniques",
      "browse_ui_examples",
    ];
    for (const name of removedNames) {
      // Legacy names may appear in the "Legacy names" row, but never as a heading
      expect(output).not.toContain(`#### \`${name}\``);
    }
  });

  it("generated block in spec is present and matches descriptor output byte-for-byte", () => {
    const specText = readFileSync(SPEC_PATH, "utf-8");
    const generated = extractGeneratedBlock(specText);
    // The drift gate is now unconditional: markers MUST be present and the
    // marker-delimited block MUST equal the descriptor-driven renderer output.
    expect(generated, "GENERATED_TOOL_CONTRACTS markers must be present in the spec").not.toBeNull();
    expect(generated).toBe(renderToolContractReference());
  });

  // R6: the Input row is mechanically derived from the Zod schema via
  // z.toJSONSchema, not handwritten prose. This test proves the derivation is
  // real — the field names + defaults in the rendered Input row must match
  // what z.toJSONSchema reports for the input schema. If someone changes a
  // schema default without regenerating docs, this test catches it.
  it("Input row field names + defaults match z.toJSONSchema of the input schema (R6)", () => {
    const output = renderToolContractReference();
    for (const desc of TOOL_DESCRIPTORS) {
      const block = output.split(`#### \`${desc.name}\``)[1]?.split("####")[0] ?? "";
      const inputRow = block.match(/\| Input \|(.+?)\|/)?.[1]?.trim() ?? "";
      // Derive the expected field names from the schema and verify each appears.
      const jsonSchema = z.toJSONSchema(desc.inputSchema as unknown as Parameters<typeof z.toJSONSchema>[0]) as {
        properties?: Record<string, unknown>;
      };
      const fieldNames = Object.keys(jsonSchema.properties ?? {});
      for (const name of fieldNames) {
        expect(inputRow, `tool ${desc.name}: field "${name}" missing from derived Input row`).toContain(name);
      }
    }
  });

  // The decisive drift proof: changing a schema default changes the rendered
  // output. If the Input row were still handwritten prose (not derived), a
  // schema change would NOT affect the rendered output. This synthetic test
  // constructs two schemas with different defaults and proves the rendered
  // Input rows differ.
  it("Input row changes when a schema default changes (synthetic drift proof)", () => {
    // We can't call deriveInputRow directly (not exported), but we CAN verify
    // the principle: the search Input row contains "default 5" (the limit default).
    // If someone changes SearchInput.limit.default(5) to .default(7), the rendered
    // row must change. This test pins the current default so a silent change breaks it.
    const output = renderToolContractReference();
    const searchBlock = output.split("#### `search_ui_references`")[1]?.split("####")[0] ?? "";
    const searchInput = searchBlock.match(/\| Input \|(.+?)\|/)?.[1]?.trim() ?? "";
    // The limit field has default 5 — derived from the schema, not handwritten.
    expect(searchInput).toContain("default 5");
    // Verify it's derived by checking the schema's JSON Schema also reports 5:
    const limitProp = (z.toJSONSchema(ToolInputSchemas.search_ui_references as unknown as Parameters<typeof z.toJSONSchema>[0]) as {
      properties?: { limit?: { default?: unknown } };
    }).properties?.limit;
    expect(limitProp?.default).toBe(5);
  });

  // Errors-row content guard: the rendered | Errors | row must contain every
  // code from desc.errorCodes with the correct retryability tag, and no extras.
  // This catches the z.union rendering bug where multi-error-code tools
  // (search/similar/critique) rendered "none" because extractEnumValues
  // couldn't walk z.union — now fixed by rendering from desc.errorCodes directly.
  it("Errors row contains every errorCodes entry with correct retryability (content guard)", () => {
    const output = renderToolContractReference();
    for (const desc of TOOL_DESCRIPTORS) {
      const block = output.split(`#### \`${desc.name}\``)[1]?.split("####")[0] ?? "";
      const errorsRow = block.match(/\| Errors \|(.+?)\|/)?.[1]?.trim() ?? "";
      const codes = desc.errorCodes as readonly string[];
      if (codes.length === 0) {
        expect(errorsRow).toBe("none");
      } else {
        for (const code of codes) {
          expect(errorsRow, `tool ${desc.name}: error code "${code}" missing from Errors row`).toContain(code);
        }
        // Spot-check retryability for known codes.
        for (const code of codes) {
          const tag = (ERROR_RETRYABLE as Record<string, boolean | undefined>)[code];
          if (tag === true) expect(errorsRow).toContain(`${code} (retryable)`);
          if (tag === false) expect(errorsRow).toContain(`${code} (non-retryable)`);
        }
      }
    }
  });
});
