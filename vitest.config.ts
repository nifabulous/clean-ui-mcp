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
    //
    // Exclude site/src/ — the public React app's component tests live under
    // site/vite.config.ts (jsdom + site-specific setup), run via `npm run
    // site:test`. The root config uses the node environment, so picking up
    // site/src/**/*.test.ts(x) here fails with "document is not defined".
    //
    // Exclude site/tests/ — the built-site browser suite
    // (site/tests/site-browser.test.ts) reads site/dist/index.html in its
    // beforeAll. The root `npm test` (`vitest run`) runs BEFORE `site:build`,
    // so discovering it there fails with ENOENT in CI and skips the rest of
    // the gates. The browser suite runs via the dedicated
    // `npm run site:test:browser` script, which passes the file as an explicit
    // include path and runs AFTER `site:build` in the gate sequence.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.worktrees/**",
      "site/src/**",
      "site/tests/**",
    ],
  },
});
