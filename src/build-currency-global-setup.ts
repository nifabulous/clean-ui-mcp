/**
 * build-currency-global-setup.ts — Vitest `globalSetup` module.
 *
 * Registered in vitest.config.ts. Vitest guarantees `setup()` here runs exactly
 * once, in the main process, BEFORE any test file is collected or executed —
 * so it runs before src/references/generated.test.ts can rewrite the tracked
 * src/references/generated.ts, and before mcp-smoke.test.ts's beforeAll reads
 * the snapshot this module publishes.
 *
 * `setup()` walks `src/` once and records the newest mtime among emitted
 * (non-`*.test.ts`) sources — the same "build currency" snapshot
 * mcp-smoke.test.ts's `assertCompiledServerIsCurrent()` needs, but taken
 * before test-file scheduling can perturb it. globalSetup runs in the main
 * thread and cannot share in-memory state with the worker
 * threads/processes Vitest runs test files in, so the snapshot is published
 * via `process.env` (documented Vitest globalSetup pattern) — workers inherit
 * `process.env` from the main process at spawn time, which happens after
 * `setup()` returns.
 *
 * Without this, comparing `src/`'s live mtime at assertion time is order-
 * dependent: whether generated.test.ts's write-then-restore (for its drift
 * assertion) has already run by the time mcp-smoke.test.ts's beforeAll fires
 * determines whether the guard sees a fresh generated.ts mtime, with no
 * change to any file's committed content. See build-currency.ts for the
 * shared file-walk this reuses.
 */
import { resolve } from "node:path";
import { isEmittedSource, newestFile } from "./build-currency.js";

export const BUILD_CURRENCY_SRC_MTIME_ENV = "MCP_SMOKE_BUILD_CURRENCY_SRC_MTIME_MS";
export const BUILD_CURRENCY_SRC_PATH_ENV = "MCP_SMOKE_BUILD_CURRENCY_SRC_PATH";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");

export function setup(): void {
  const newestSource = newestFile(SRC_DIR, isEmittedSource);
  if (newestSource) {
    process.env[BUILD_CURRENCY_SRC_MTIME_ENV] = String(newestSource.mtimeMs);
    process.env[BUILD_CURRENCY_SRC_PATH_ENV] = newestSource.path;
  } else {
    // No emitted source found under src/ at all — publish the "checked, none
    // found" sentinel (empty string) so the reader can distinguish this from
    // "globalSetup never ran" (env var entirely unset).
    process.env[BUILD_CURRENCY_SRC_MTIME_ENV] = "";
    delete process.env[BUILD_CURRENCY_SRC_PATH_ENV];
  }
}
