import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToolContractReference, extractGeneratedBlock } from "./tool-contract-docs.js";
import { TOOL_DESCRIPTORS } from "./tool-contracts.js";

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
});
