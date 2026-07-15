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

// Derive LegacyToolName and RendererKey from the descriptor literals
import type { TOOL_DESCRIPTORS } from "./tool-contracts.js";

/** Legacy tool names — derived from all legacyNames across descriptors. */
export type LegacyToolName = (typeof TOOL_DESCRIPTORS)[number]["legacyNames"][number];

/** Renderer key union — derived from descriptor rendererKey values. */
export type RendererKey = (typeof TOOL_DESCRIPTORS)[number]["rendererKey"];
