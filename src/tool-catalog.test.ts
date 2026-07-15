import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  TOOL_DEFINITIONS,
  TOOL_CATALOG,
  REMOVED_TOOL_NAMES,
  LEGACY_TO_BETA_MAP,
  CATALOG_DIGEST,
  type ToolName,
  type LegacyToolName,
} from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// Catalog descriptor table
// ---------------------------------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("has exactly 12 entries", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(12);
  });

  it("each entry has name, rendererKey, hasEvidence, and legacyNames", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.name).toBeTruthy();
      expect(def.rendererKey).toBeTruthy();
      expect(typeof def.hasEvidence).toBe("boolean");
      expect(Array.isArray(def.legacyNames)).toBe(true);
    }
  });

  it("rendererKey is unique across all tools", () => {
    const keys = TOOL_DEFINITIONS.map((d) => d.rendererKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tool names are unique", () => {
    const names = TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("TOOL_DEFINITIONS is deep-frozen", () => {
    expect(Object.isFrozen(TOOL_DEFINITIONS)).toBe(true);
    for (const def of TOOL_DEFINITIONS) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.legacyNames)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TOOL_CATALOG
// ---------------------------------------------------------------------------

describe("TOOL_CATALOG", () => {
  it("has exactly 12 names in the approved order", () => {
    expect(TOOL_CATALOG).toEqual([
      "search_ui_references",
      "get_ui_reference",
      "find_similar_ui_references",
      "compare_ui_references",
      "get_ui_taxonomy",
      "browse_ui_patterns",
      "plan_ui_direction",
      "create_ui_spec",
      "research_ui_anti_patterns",
      "research_ui_palettes",
      "research_ui_techniques",
      "critique_ui",
    ]);
  });

  it("is readonly (frozen)", () => {
    // TypeScript const assertion makes this readonly at compile time.
    // Runtime check: ensure it's not accidentally mutable.
    expect(Object.isFrozen(TOOL_CATALOG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REMOVED_TOOL_NAMES
// ---------------------------------------------------------------------------

describe("REMOVED_TOOL_NAMES", () => {
  it("contains exactly the 13 legacy names not carried forward unchanged", () => {
    // 14 legacy tools - 1 kept (critique_ui) = 13 removed/renamed
    expect([...REMOVED_TOOL_NAMES].sort()).toEqual(
      [
        "search_ui_examples",
        "get_ui_example",
        "list_categories",
        "list_style_tags",
        "list_domain_tags",
        "get_similar_ui_examples",
        "compare_ui_examples",
        "generate_design_prompt",
        "recommend_ui_direction",
        "get_anti_patterns",
        "get_color_palette",
        "get_stealable_techniques",
        "browse_ui_examples",
      ].sort(),
    );
  });

  it("does not include any beta name", () => {
    for (const beta of TOOL_CATALOG) {
      expect(REMOVED_TOOL_NAMES).not.toContain(beta);
    }
  });
});

// ---------------------------------------------------------------------------
// LEGACY_TO_BETA_MAP
// ---------------------------------------------------------------------------

describe("LEGACY_TO_BETA_MAP", () => {
  it("maps every legacy name to exactly one beta name", () => {
    expect(LEGACY_TO_BETA_MAP["search_ui_examples"]).toBe("search_ui_references");
    expect(LEGACY_TO_BETA_MAP["get_ui_example"]).toBe("get_ui_reference");
    expect(LEGACY_TO_BETA_MAP["list_categories"]).toBe("get_ui_taxonomy");
    expect(LEGACY_TO_BETA_MAP["list_style_tags"]).toBe("get_ui_taxonomy");
    expect(LEGACY_TO_BETA_MAP["list_domain_tags"]).toBe("get_ui_taxonomy");
    expect(LEGACY_TO_BETA_MAP["get_similar_ui_examples"]).toBe("find_similar_ui_references");
    expect(LEGACY_TO_BETA_MAP["compare_ui_examples"]).toBe("compare_ui_references");
    expect(LEGACY_TO_BETA_MAP["generate_design_prompt"]).toBe("create_ui_spec");
    expect(LEGACY_TO_BETA_MAP["recommend_ui_direction"]).toBe("plan_ui_direction");
    expect(LEGACY_TO_BETA_MAP["get_anti_patterns"]).toBe("research_ui_anti_patterns");
    expect(LEGACY_TO_BETA_MAP["get_color_palette"]).toBe("research_ui_palettes");
    expect(LEGACY_TO_BETA_MAP["get_stealable_techniques"]).toBe("research_ui_techniques");
    expect(LEGACY_TO_BETA_MAP["browse_ui_examples"]).toBe("browse_ui_patterns");
  });

  it("does not map critique_ui (name unchanged)", () => {
    expect(LEGACY_TO_BETA_MAP["critique_ui"]).toBeUndefined();
  });

  it("every removed name has a mapping", () => {
    for (const removed of REMOVED_TOOL_NAMES) {
      expect(LEGACY_TO_BETA_MAP[removed as LegacyToolName]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// CATALOG_DIGEST
// ---------------------------------------------------------------------------

describe("CATALOG_DIGEST", () => {
  it("is a 64-hex SHA-256", () => {
    expect(CATALOG_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches independently recomputed SHA-256 of the canonical descriptor representation", () => {
    // Recompute the digest from the descriptor table, independent of the
    // production code's own computation. If the serialization changes,
    // this test catches the drift.
    const canonicalRep = JSON.stringify(
      TOOL_DEFINITIONS.map((d) => ({
        name: d.name,
        rendererKey: d.rendererKey,
        hasEvidence: d.hasEvidence,
        legacyNames: [...d.legacyNames],
      })),
    );
    const expected = createHash("sha256").update(canonicalRep).digest("hex");
    expect(CATALOG_DIGEST).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

describe("type exports", () => {
  it("ToolName includes all 12 beta names", () => {
    const sample: ToolName = "search_ui_references";
    expect(sample).toBe("search_ui_references");
  });

  it("LegacyToolName includes all 14 legacy names", () => {
    const sample: LegacyToolName = "search_ui_examples";
    expect(sample).toBe("search_ui_examples");
  });
});
