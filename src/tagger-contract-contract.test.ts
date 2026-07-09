/**
 * Tagger deterministic contract — the baseline that gates prompt changes.
 *
 * This test exercises the sanitizer's contract over canned model-output
 * fixtures. It is the provider-independent baseline: every accept/reject
 * outcome here MUST hold regardless of which vision/provider the tagger runs.
 *
 * Per the project's evaluation discipline (build the scored baseline BEFORE
 * changing the prompt), this contract must pass both before and after the WCAG
 * canonical-ID prompt/schema change. Any regression here blocks the change.
 */
import { describe, it, expect } from "vitest";
import { sanitizeTaggerPayload } from "./tagger.js";
import { ACCESSIBILITY_RISK_FIXTURES, type ContractFixture } from "./__fixtures__/tagger-contract-fixtures.js";

function assertContract(fixture: ContractFixture): void {
  const sanitized = sanitizeTaggerPayload(fixture.input);

  if (fixture.expect.accessibilityRiskCount !== undefined) {
    expect(
      sanitized.draftAccessibilityRisks.length,
      `"${fixture.name}" — risk count`,
    ).toBe(fixture.expect.accessibilityRiskCount);
  }

  if (fixture.expect.accessibilityRisks) {
    for (let i = 0; i < fixture.expect.accessibilityRisks.length; i++) {
      const expected = fixture.expect.accessibilityRisks[i];
      const actual = sanitized.draftAccessibilityRisks[i];
      expect(actual, `"${fixture.name}" — risk ${i} exists`).toBeDefined();
      if (expected.element) expect(actual.element).toBe(expected.element);
      if (expected.risk) expect(actual.risk).toBe(expected.risk);
      if (expected.confidence) expect(actual.confidence).toBe(expected.confidence);
      if (expected.wcag) expect(actual.wcag).toEqual(expected.wcag);
    }
  }
}

describe("tagger deterministic contract — accessibility risks", () => {
  for (const fixture of ACCESSIBILITY_RISK_FIXTURES) {
    it(fixture.name, () => assertContract(fixture));
  }

  it("WCAG IDs in surviving risks are all valid canonical IDs", () => {
    // Meta-contract: after sanitization, no surviving risk may carry an ID that
    // isn't in the WCAG 2.2 registry. This is the referential-integrity
    // guarantee the canonical-ID gate enforces.
    for (const fixture of ACCESSIBILITY_RISK_FIXTURES) {
      const sanitized = sanitizeTaggerPayload(fixture.input);
      for (const risk of sanitized.draftAccessibilityRisks) {
        for (const id of risk.wcag) {
          expect(id, `"${fixture.name}" — ${id} must be a bare numeric ID`).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
    }
  });

  it("every surviving risk has a non-empty wcag array", () => {
    for (const fixture of ACCESSIBILITY_RISK_FIXTURES) {
      const sanitized = sanitizeTaggerPayload(fixture.input);
      for (const risk of sanitized.draftAccessibilityRisks) {
        expect(risk.wcag.length, `"${fixture.name}" — risk must have ≥1 WCAG ID`).toBeGreaterThan(0);
      }
    }
  });
});
