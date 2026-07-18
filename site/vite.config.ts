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
  },
});
