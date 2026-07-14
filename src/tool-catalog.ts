/**
 * Canonical MCP tool catalog — single source of truth.
 *
 * `TOOL_DEFINITIONS` is the one descriptor array from which everything else is
 * derived: the ordered catalog, removed legacy names, the legacy→beta map,
 * and the canonical catalog digest. Never maintain a second hand-written name
 * or removed-name list.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 12 beta tool names. */
export type ToolName =
  | "search_ui_references"
  | "get_ui_reference"
  | "find_similar_ui_references"
  | "compare_ui_references"
  | "get_ui_taxonomy"
  | "browse_ui_patterns"
  | "plan_ui_direction"
  | "create_ui_spec"
  | "research_ui_anti_patterns"
  | "research_ui_palettes"
  | "research_ui_techniques"
  | "critique_ui";

/** The 14 legacy tool names being replaced. */
export type LegacyToolName =
  | "search_ui_examples"
  | "get_ui_example"
  | "list_categories"
  | "list_style_tags"
  | "list_domain_tags"
  | "get_similar_ui_examples"
  | "compare_ui_examples"
  | "generate_design_prompt"
  | "recommend_ui_direction"
  | "get_anti_patterns"
  | "get_color_palette"
  | "get_stealable_techniques"
  | "browse_ui_examples"
  | "critique_ui";

/** Key used by the renderer registry to select the text formatter. */
export type RendererKey =
  | "search"
  | "reference"
  | "similar"
  | "compare"
  | "taxonomy"
  | "browse"
  | "plan"
  | "spec"
  | "anti-patterns"
  | "palettes"
  | "techniques"
  | "critique";

/** One catalog entry. */
export interface ToolDefinition {
  /** Beta tool name. */
  readonly name: ToolName;
  /** Renderer registry key for text formatting. */
  readonly rendererKey: RendererKey;
  /** Whether this tool emits claim-level evidence arrays. */
  readonly hasEvidence: boolean;
  /** Legacy tool names that map to this beta tool. */
  readonly legacyNames: readonly LegacyToolName[];
}

// ---------------------------------------------------------------------------
// The single descriptor table
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "search_ui_references",
    rendererKey: "search",
    hasEvidence: false,
    legacyNames: ["search_ui_examples"],
  },
  {
    name: "get_ui_reference",
    rendererKey: "reference",
    hasEvidence: false,
    legacyNames: ["get_ui_example"],
  },
  {
    name: "find_similar_ui_references",
    rendererKey: "similar",
    hasEvidence: false,
    legacyNames: ["get_similar_ui_examples"],
  },
  {
    name: "compare_ui_references",
    rendererKey: "compare",
    hasEvidence: false,
    legacyNames: ["compare_ui_examples"],
  },
  {
    name: "get_ui_taxonomy",
    rendererKey: "taxonomy",
    hasEvidence: false,
    legacyNames: ["list_categories", "list_style_tags", "list_domain_tags"],
  },
  {
    name: "browse_ui_patterns",
    rendererKey: "browse",
    hasEvidence: false,
    legacyNames: ["browse_ui_examples"],
  },
  {
    name: "plan_ui_direction",
    rendererKey: "plan",
    hasEvidence: true,
    legacyNames: ["recommend_ui_direction"],
  },
  {
    name: "create_ui_spec",
    rendererKey: "spec",
    hasEvidence: true,
    legacyNames: ["generate_design_prompt"],
  },
  {
    name: "research_ui_anti_patterns",
    rendererKey: "anti-patterns",
    hasEvidence: false,
    legacyNames: ["get_anti_patterns"],
  },
  {
    name: "research_ui_palettes",
    rendererKey: "palettes",
    hasEvidence: false,
    legacyNames: ["get_color_palette"],
  },
  {
    name: "research_ui_techniques",
    rendererKey: "techniques",
    hasEvidence: false,
    legacyNames: ["get_stealable_techniques"],
  },
  {
    name: "critique_ui",
    rendererKey: "critique",
    hasEvidence: true,
    legacyNames: [], // critique_ui keeps its name — no legacy mapping needed
  },
] as const;

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/** The ordered 12-name beta catalog. */
export const TOOL_CATALOG: readonly ToolName[] = Object.freeze(
  TOOL_DEFINITIONS.map((d) => d.name),
);

/** Legacy names that are removed (not carried forward under any beta name). */
export const REMOVED_TOOL_NAMES: readonly string[] = Object.freeze(
  Array.from(
    new Set(
      TOOL_DEFINITIONS.flatMap((d) => d.legacyNames),
    ),
  ).sort(),
);

/** Maps each legacy tool name to its beta replacement. */
export const LEGACY_TO_BETA_MAP: Readonly<Record<string, ToolName>> = Object.freeze(
  Object.fromEntries(
    TOOL_DEFINITIONS.flatMap((d) =>
      d.legacyNames.map((legacy) => [legacy, d.name] as const),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Canonical catalog digest
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the canonical JSON representation of the catalog.
 * Changes when any tool name, order, or legacy mapping changes.
 */
export const CATALOG_DIGEST: string = createHash("sha256")
  .update(
    JSON.stringify(
      TOOL_DEFINITIONS.map((d) => ({
        name: d.name,
        rendererKey: d.rendererKey,
        hasEvidence: d.hasEvidence,
        legacyNames: [...d.legacyNames],
      })),
    ),
  )
  .digest("hex");
