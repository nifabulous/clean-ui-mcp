/**
 * Canonical MCP tool catalog — thin re-export from tool-contracts.ts.
 *
 * TOOL_DESCRIPTORS is the single source of truth. This module derives and
 * exports the catalog types and values that consumers need.
 */
export {
  TOOL_DESCRIPTORS,
  TOOL_CATALOG,
  LEGACY_TO_BETA_MAP,
  REMOVED_TOOL_NAMES,
  CATALOG_DIGEST,
  type ToolName,
} from "./tool-contracts.js";

// Re-export type aliases for backward compatibility with existing imports
import type { ToolName } from "./tool-contracts.js";

/** Legacy tool names (union of all legacyNames across descriptors). */
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

/** Renderer key union derived from descriptor rendererKey values. */
export type RendererKey =
  | "search" | "reference" | "similar" | "compare" | "taxonomy"
  | "browse" | "plan" | "spec" | "anti-patterns" | "palettes"
  | "techniques" | "critique";
