/**
 * Compile-time contract assertions for per-tool type inference.
 * Type-checked via: npm run typecheck:contracts
 *
 * Type assertions are enforced at compile time. The vitest runtime test
 * is a placeholder so the file isn't reported as having no tests.
 *
 * Proof mechanism: `@ts-expect-error` directives. If a directive does NOT
 * suppress an actual error, TypeScript reports "Unused '@ts-expect-error'
 * directive" and `typecheck:contracts` fails. A passing typecheck therefore
 * proves BOTH that the directive is needed AND that it suppresses a real
 * type error — i.e. the literal per-tool error inference is genuinely tight.
 */
import { ToolInputSchemas, type ToolInputByName, type ToolDataByName, type ToolResultByName, type ToolName } from "./tool-contracts.js";
import { describe, it, expect } from "vitest";

// Known tool names must compile
const _search: ToolName = "search_ui_references";
void _search;

// Per-tool input types preserve inference
const _searchInput: ToolInputByName<"search_ui_references"> = { limit: 5, query: "test" };
void _searchInput;

// Per-tool data types preserve inference — a REAL assignment, not a self-cast.
// create_ui_spec data is UiSpec; proving literal inference means at least one
// real field must be assigned from scratch (specVersion is a literal "1.0").
const _specData: ToolDataByName<"create_ui_spec"> = {
  specVersion: "1.0",
  context: {
    productContext: "a calm analytics dashboard for a fintech",
    constraints: [],
  },
  designDirection: "Quiet editorial restraint",
  rejectedDefaults: [],
  layoutRegions: [],
  responsiveBehavior: [],
  componentInventory: [],
  colorTokens: null,
  colorTokenAuthority: "editorial",
  typographyTokens: null,
  typographyTokenAuthority: "editorial",
  interactions: [],
  motionGuidance: { notes: [], evidenceUnavailable: true },
  accessibilityConstraints: [],
  techniques: [],
  antiPatterns: [],
  unavailableDecisions: [
    { field: "colorTokens", reason: "no corpus color evidence available" },
    { field: "typographyTokens", reason: "no corpus typography evidence available" },
    { field: "motion", reason: "no motion evidence available" },
  ],
  acceptanceCriteria: [
    {
      id: "ac-1",
      subject: "primary surface",
      assertion: "exists",
      expectedOutcome: "a primary surface region renders",
      verifier: "manual",
      priority: "must",
      evidenceIds: [],
      manualSteps: ["open the page"],
    },
  ],
  citedReferences: [],
  citedDecisions: [],
  authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
  provenance: {
    generatedAt: "2026-07-16T00:00:00.000Z",
    toolVersion: "clean-ui-mcp 0.2.0",
    sourceReferences: [],
    evidenceIds: [],
  },
};
void _specData;

// Per-tool result error type preserves LITERAL code↔retryable binding.
// get_ui_reference's only application error is NOT_FOUND, which is non-retryable.
// A valid NOT_FOUND error must compile (retryable: false).
const _errLiteral: ToolResultByName<"get_ui_reference">["error"] = {
  code: "NOT_FOUND",
  message: "missing",
  retryable: false,
};
void _errLiteral;

// @ts-expect-error NOT_FOUND is never retryable — retryable:true must be a type error.
const _errRetryableMismatch: ToolResultByName<"get_ui_reference">["error"] = { code: "NOT_FOUND", message: "missing", retryable: true };
void _errRetryableMismatch;

// @ts-expect-error unknown tool key — ToolInputSchemas is exact-keyed, so a
// non-existent tool name must be a type error (not `any`).
ToolInputSchemas.not_a_tool;

describe("tool-contract-types (compile-time)", () => {
  it("compiles without type errors", () => {
    expect(true).toBe(true);
  });
});
