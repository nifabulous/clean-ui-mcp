import { defineConfig } from "vitest/config";

// Dedicated config for the built-site browser suites plus their companion unit
// test. The ROOT vitest.config.ts excludes site/tests/** so `npm test` does not
// run these before `site:build` (each browser suite's beforeAll reads
// site/dist/index.html, which ENOENT-fails in CI when the root suite runs
// first). This config is used only by the `site:test:browser*` scripts, which
// the gate sequence runs AFTER `site:build`.
//
// It deliberately does NOT exclude site/tests/** — it includes exactly the three
// files below. The parse unit test runs regardless of `site:build` (it doesn't
// touch the dist), but keeping it in this config means `npm test` (root) doesn't
// run it either — consistent with the rest of site/tests/.
//
// TWO SERVER FIXTURES, TWO SCRIPTS, ONE CONFIG:
//
//   site/tests/site-browser.test.ts             — `vite preview` fixture.
//                                                 Static only, so `/api/*` is
//                                                 intercepted with bytes produced
//                                                 by the real HTTP adapter.
//                                                 Run by `site:test:browser`.
//   site/tests/site-production-browser.test.ts  — PRODUCTION loopback fixture.
//                                                 Spawns dist/scripts/ui-server.js
//                                                 with CLEAN_UI_SITE_DIST=site/dist
//                                                 (what `npm run ui` runs) and
//                                                 uses its REAL `/api/*`.
//                                                 Run by
//                                                 `site:test:browser:production`.
//
// The two scripts pass explicit file filters rather than relying on this
// include list, because the production suite has an extra precondition the
// preview suite does not: a current `dist/` (it spawns the compiled server).
// Keeping `site:test:browser` filtered to the preview files preserves its exact
// pre-existing scope, so adding the production suite here cannot change what
// that command runs.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: [
      "site/tests/site-browser.test.ts",
      "site/tests/site-production-browser.test.ts",
      "site/tests/preview-url-parse.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
