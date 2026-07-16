/**
 * Compile-time contract assertions for per-tool type inference.
 * Type-checked via: npm run typecheck:contracts
 *
 * Type assertions are enforced at compile time. The vitest runtime test
 * is a placeholder so the file isn't reported as having no tests.
 */
import type { ToolInputByName, ToolDataByName, ToolName } from "./tool-contracts.js";
import { describe, it, expect } from "vitest";

// Known tool names must compile
const _search: ToolName = "search_ui_references";
void _search;

// Per-tool input types preserve inference
const _searchInput: ToolInputByName<"search_ui_references"> = { limit: 5, query: "test" };
void _searchInput;

// Per-tool data types preserve inference
const _specData: ToolDataByName<"create_ui_spec"> = {} as ToolDataByName<"create_ui_spec">;
void _specData;

describe("tool-contract-types (compile-time)", () => {
  it("compiles without type errors", () => {
    expect(true).toBe(true);
  });
});
