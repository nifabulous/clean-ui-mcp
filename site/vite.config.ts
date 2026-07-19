/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/clean-ui-mcp/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    globals: true,
    // jsdom + React 19 + MiniSearch cold-starts are CPU-heavy; under parallel
    // file execution the default 5s budget is not enough for the snapshot-load
    // waitFor polls (especially the Playground/Evidence pages). 15s gives the
    // whole suite headroom on cold/loaded CI runners without masking genuine
    // hangs (which would still blow past this).
    testTimeout: 15_000,
    // The end-to-end browser suite (tests/site-browser.test.ts) spawns a real
    // Chromium + `vite preview` server against a BUILT site/dist, so it must run
    // AFTER `site:build` and only via the dedicated `site:test:browser` script
    // (which uses the root vitest config + an explicit file path, so this exclude
    // does not affect it). Excluding it here keeps `site:test` self-contained —
    // it can run before the build in the gate (site:test → site:build →
    // site:test:browser) without failing on a missing/ stale dist.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/site-browser.test.ts",
    ],
  },
});
