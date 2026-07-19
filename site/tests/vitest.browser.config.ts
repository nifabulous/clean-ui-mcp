import { defineConfig } from "vitest/config";

// Dedicated config for the built-site browser suite
// (site/tests/site-browser.test.ts). The ROOT vitest.config.ts excludes
// site/tests/** so `npm test` does not run this suite before `site:build`
// (its beforeAll reads site/dist/index.html, which ENOENT-fails in CI when
// the root suite runs first). This config is used only by
// `npm run site:test:browser`, which the gate sequence runs AFTER `site:build`.
//
// It deliberately does NOT exclude site/tests/** — it includes exactly the one
// browser suite file.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ["site/tests/site-browser.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
