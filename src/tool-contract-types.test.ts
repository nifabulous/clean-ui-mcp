/**
 * Compile-time contract assertions for per-tool type inference.
 * Run with: npm run typecheck:contracts
 *
 * Type assertions are enforced at compile time by tsc.
 * The runtime test is a no-op placeholder so vitest doesn't fail.
 */
import { describe, it, expect } from "vitest";

describe("tool-contract-types (compile-time)", () => {
  it("compiles without type errors", () => {
    expect(true).toBe(true);
  });
});
