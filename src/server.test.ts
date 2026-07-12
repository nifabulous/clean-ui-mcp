import { describe, expect, it } from "vitest";
import { pickMode } from "./server.js";

/**
 * server.test.ts — F1 (Gate 1A), the fail-CLOSED mode selector.
 *
 * The previous `pickMode` returned "private" for ANY value except the exact
 * string "public", so a typo like CLEAN_UI_MODE=publci started the server in
 * PRIVATE mode and served the full private corpus — exactly the leak this gate
 * exists to prevent. These tests pin the corrected contract: absent/empty →
 * private (historical default, keeps the smoke test working), recognized → that
 * mode, ANY other non-empty value → throws at startup naming the bad value.
 *
 * `pickMode` takes the env as an explicit parameter (rather than reading
 * process.env directly) so the tests are hermetic and don't need to mutate +
 * restore the global env between cases.
 */
describe("pickMode (F1) — fail-CLOSED on unrecognized CLEAN_UI_MODE", () => {
  it("absent (unset) → private (historical default; smoke test sets no env)", () => {
    expect(pickMode({})).toBe("private");
    expect(pickMode({ OTHER: "x" })).toBe("private");
  });

  it("empty string → private (treated like unset)", () => {
    expect(pickMode({ CLEAN_UI_MODE: "" })).toBe("private");
  });

  it('"public" → public', () => {
    expect(pickMode({ CLEAN_UI_MODE: "public" })).toBe("public");
  });

  it('"private" → private', () => {
    expect(pickMode({ CLEAN_UI_MODE: "private" })).toBe("private");
  });

  it('throws on "publci" (the typo that previously leaked the private corpus)', () => {
    expect(() => pickMode({ CLEAN_UI_MODE: "publci" })).toThrow(/publci/);
  });

  it("throws on any other non-empty value, naming the bad value + valid options", () => {
    const cases = ["PUBLIC", "Public", "prod", "1", "true", "public ", " public"];
    for (const bad of cases) {
      expect(() => pickMode({ CLEAN_UI_MODE: bad }), `bad value=${JSON.stringify(bad)}`).toThrow(
        /CLEAN_UI_MODE/,
      );
      // The error must name the offending value so the operator can fix it.
      expect(() => pickMode({ CLEAN_UI_MODE: bad })).toThrow(
        new RegExp(bad.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    // And must list the valid options so the fix is obvious.
    expect(() => pickMode({ CLEAN_UI_MODE: "bogus" })).toThrow(/public.*private/s);
  });

  it("defaults to process.env when no arg is passed (the real call path)", () => {
    // process.env has no CLEAN_UI_MODE in the test runner → private.
    const prev = process.env.CLEAN_UI_MODE;
    delete process.env.CLEAN_UI_MODE;
    try {
      expect(pickMode()).toBe("private");
    } finally {
      if (prev !== undefined) process.env.CLEAN_UI_MODE = prev;
    }
  });
});
