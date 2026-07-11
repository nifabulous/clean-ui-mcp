import { describe, expect, it } from "vitest";
import { CRITIQUE_UI_OUTPUT_SCHEMA } from "./contracts.js";
import { buildStructuredCritique } from "./structured-output.js";

describe("buildStructuredCritique", () => {
  it("returns a schema-valid payload with synthesized findings and selected reference metadata", () => {
    const result = buildStructuredCritique({
      platform: "web", retrieval: { mode: "structured-fallback", fallbackUsed: true, coverage: "moderate" },
      gated: {
        summary: "A review.", observations: [], recommendations: [], accessibilityRisks: [],
        visualSlop: [{ pattern: "Gradient hero", basis: "visible", evidence: ["screen:patternType"] }],
        motion: [{ basis: "editorial", evidence: ["dom:motion:0"], note: "Use restraint", reference: "ref:design-engineering" }],
      },
      evidenceIds: ["screen:patternType", "dom:motion:0"],
      guidance: [{ id: "ref:design-engineering", label: "Design engineering", version: 1, purpose: "motion-guidance" }],
    });

    // This is the same schema registered by server.ts, proving the actual
    // response construction is consumable by schema-aware MCP clients.
    expect(CRITIQUE_UI_OUTPUT_SCHEMA.safeParse(result)).toMatchObject({ success: true });
    expect(result.visualSlop).toHaveLength(1);
    expect(result.motion).toHaveLength(1);
    expect(result.appliedReferences).toEqual([{ id: "ref:design-engineering", version: 1, purpose: "motion-guidance" }]);
  });
});
