import { defineConfig } from "vitest/config";

// Dedicated config for the built-site browser suite
// (site/tests/site-browser.test.ts) plus its companion unit test
// (site/tests/preview-url-parse.test.ts). The ROOT vitest.config.ts excludes
// site/tests/** so `npm test` does not run these before `site:build`
// (the browser suite's beforeAll reads site/dist/index.html, which ENOENT-fails
// in CI when the root suite runs first). This config is used only by
// `npm run site:test:browser`, which the gate sequence runs AFTER `site:build`.
//
// It deliberately does NOT exclude site/tests/** — it includes exactly these
// two files. The parse unit test runs regardless of `site:build` (it doesn't
// touch the dist), but keeping it in this config means `npm test` (root)
// doesn't run it either — consistent with the rest of site/tests/.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ["site/tests/site-browser.test.ts", "site/tests/preview-url-parse.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
