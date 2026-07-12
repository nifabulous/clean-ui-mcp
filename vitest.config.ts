import { defineConfig } from "vitest/config";

// Project-wide vitest config. The interesting knob here is testTimeout: the
// default 5s was too tight for browser tests under full-suite load (Playwright
// page creation + network round-trips to the test server can exceed 5s when
// the suite is running in parallel with the build/validate pipeline). 15s
// matches the explicit timeout the existing bulk-import browser test already
// uses, and doesn't slow unit tests (they finish in <1s regardless).
//
// Browser tests are still individually responsible for tight waitForSelector
// timeouts where they want to fail fast on a real regression — those are
// Playwright's own timeouts, separate from vitest's test-level timeout.
//
// Tests WITHIN a file already run serially by default, which is what the
// browser tests need (they share a browser + server + mutable state across
// describe blocks). Files still run in parallel, which keeps the unit-test
// wall-clock time short.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    // Exclude git worktrees — they contain stale copies of tests that vitest
    // picks up and double-counts (e.g. .worktrees/reference-synthesis/ still
    // has the deleted grok-eval.mjs tests).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
