/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The loopback curator/API server (`npm run ui`). Its port default —  3131 — and
 * its `CLEAN_UI_PORT` override both come from src/scripts/ui-server.ts, so the two
 * cannot drift: set `CLEAN_UI_PORT` and the proxy follows.
 *
 * The target is 127.0.0.1, never `localhost`, so the OS resolver cannot send the
 * proxied request to an IPv6 or rebound address — the same reason the server binds
 * 127.0.0.1 rather than a hostname.
 */
const LOOPBACK_API_PORT = process.env.CLEAN_UI_PORT ?? "3131";
const LOOPBACK_API_TARGET = `http://127.0.0.1:${LOOPBACK_API_PORT}`;

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/clean-ui-mcp/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  // DEVELOPMENT ONLY. `vite dev` serves the app on its own port, so a relative
  // `/api/*` fetch from the page would hit Vite rather than the loopback server.
  // This proxy forwards `/api` to that server so the composer's same-origin
  // client works unchanged in development.
  //
  // PRODUCTION DOES NOT USE THIS. The built site is served by the SAME
  // operator-controlled process that owns `/api` — src/scripts/ui-server.ts mounts
  // `site/dist` under `/clean-ui-mcp/` when `CLEAN_UI_SITE_DIST` is set, and its
  // `/api/` branch is matched before the static branch. So in production the
  // composer's `/api/create-ui-spec` is genuinely same-origin with no proxy in the
  // path, and `vite preview` (which does not read this `server` block) serves the
  // static site only — the browser suite therefore stubs the route rather than
  // silently reaching a different origin.
  //
  // `changeOrigin` MUST stay false. The server's local-origin guard compares the
  // request's `Origin` against its `Host`; rewriting Host to 127.0.0.1:<port>
  // while the browser still sends `Origin: http://localhost:5173` would make every
  // proxied mutation fail the guard with a 403.
  server: {
    proxy: {
      "/api": {
        target: LOOPBACK_API_TARGET,
        changeOrigin: false,
      },
    },
  },
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
