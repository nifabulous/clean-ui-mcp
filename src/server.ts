#!/usr/bin/env node
/**
 * server.ts — the executable entry point for the clean-ui-mcp server.
 *
 * Gate 1A, Tasks 4a/4b (F7). This module is intentionally tiny: it reads the
 * mode from `CLEAN_UI_MODE`, constructs the appropriate `CorpusReader`,
 * calls `createServer(reader)` (from server-factory.ts), connects a stdio
 * transport, and logs the readiness signal. All tool registration lives in
 * server-factory.ts now — importing THIS module is what starts a server and
 * opens stdio; importing server-factory.ts does NOT.
 *
 * Mode selection: `CLEAN_UI_MODE` env var.
 *   - absent / unrecognized / `"private"` → PrivateCorpusReader (historical
 *     default; reads the full mutable corpus). This keeps the smoke test
 *     (which sets no mode) working unchanged.
 *   - `"public"` → PublicCorpusReader (Task 4b). Loads a finalized public
 *     snapshot from `CLEAN_UI_PUBLIC_SNAPSHOT` (or a default under
 *     `PUBLIC_SNAPSHOT_DIR`) and serves ONLY its eligible entries. If the
 *     snapshot doesn't exist, the server fails fast with a clear error — there
 *     is no silent fallback to private mode, which would leak the private
 *     corpus.
 *
 * The `bin` entry (`dist/server.js`) and mcp-smoke.test.ts (which spawns
 * `dist/server.js` expecting auto-start + the readiness string) depend on
 * the bottom-of-module `main()` call — keep it.
 */
import "./env.js";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer } from "./server-factory.js";
import { PrivateCorpusReader, PublicCorpusReader, type CorpusMode, type CorpusReader } from "./corpus-reader.js";
import { PUBLIC_SNAPSHOT_DIR } from "./paths.js";

/**
 * Resolve `CLEAN_UI_MODE` to a CorpusMode. F1 (Gate 1A): this is fail-CLOSED,
 * not fail-open.
 *
 *   - absent / empty / unset → `"private"` (the historical default; keeps the
 *     smoke test, which sets no env var, working unchanged).
 *   - `"public"`  → `"public"`
 *   - `"private"` → `"private"`
 *   - ANY OTHER non-empty value → throws at startup. A typo like `publci` MUST
 *     NOT silently fall back to private (the previous behavior served the full
 *     private corpus for any unrecognized value — a direct leak the gate exists
 *     to prevent). Naming the bad value + valid options makes the operator's
 *     fix obvious.
 *
 * Exported (and `main()` is guarded by `isMainModule`) so the mode-selection
 * logic is unit-testable in isolation without importing a module that starts a
 * stdio server as a side effect.
 */
export function pickMode(env: NodeJS.ProcessEnv = process.env): CorpusMode {
  const raw = env.CLEAN_UI_MODE;
  // Absent or empty → private (historical default; smoke test sets no env).
  if (raw === undefined || raw === "") return "private";
  if (raw === "public" || raw === "private") return raw;
  // Unrecognized non-empty value → fail CLOSED with a clear, actionable error.
  throw new Error(
    `[clean-ui-mcp] Unrecognized CLEAN_UI_MODE=${JSON.stringify(raw)}. `
    + `Valid values: "public", "private", or unset/empty (defaults to "private").`,
  );
}

/**
 * Resolve the public snapshot path. `CLEAN_UI_PUBLIC_SNAPSHOT` may be either the
 * snapshot directory itself or its parent (in which case we pick the single
 * committed snapshot under it). Defaults to `PUBLIC_SNAPSHOT_DIR`. Returns null
 * if no usable snapshot directory exists.
 */
function resolvePublicSnapshotPath(): string | null {
  const raw = process.env.CLEAN_UI_PUBLIC_SNAPSHOT;
  const candidate = raw && raw.length > 0 ? raw : PUBLIC_SNAPSHOT_DIR;
  if (existsSync(candidate) && hasSnapshotFiles(candidate)) return candidate;
  // If the candidate is a parent dir containing snapshot subdirectories, pick
  // the one (and only) snapshot. Multiple snapshots → ambiguous, refuse.
  if (existsSync(candidate)) {
    const child = singleSnapshotChild(candidate);
    if (child) return child;
  }
  return null;
}

function hasSnapshotFiles(dir: string): boolean {
  return existsSync(`${dir}/entries.json`) && existsSync(`${dir}/manifest.json`);
}

function singleSnapshotChild(parent: string): string | null {
  let child: string | null = null;
  for (const name of readdirSync(parent)) {
    if (name.startsWith(".")) continue;
    const sub = `${parent}/${name}`;
    if (hasSnapshotFiles(sub)) {
      if (child !== null) return null; // ambiguous: more than one snapshot
      child = sub;
    }
  }
  return child;
}

function buildReader(mode: CorpusMode): CorpusReader {
  if (mode === "public") {
    const snapshotPath = resolvePublicSnapshotPath();
    if (!snapshotPath) {
      // Fail fast with a clear message. Do NOT fall back to private mode — that
      // would silently serve the private corpus, which is exactly the leak this
      // mode is meant to prevent.
      throw new Error(
        `[clean-ui-mcp] CLEAN_UI_MODE=public but no public snapshot found. `
        + `Set CLEAN_UI_PUBLIC_SNAPSHOT to a snapshot directory (containing `
        + `entries.json + manifest.json), or export one under `
        + `${PUBLIC_SNAPSHOT_DIR}.`,
      );
    }
    return new PublicCorpusReader(snapshotPath);
  }
  return new PrivateCorpusReader();
}

async function main(): Promise<void> {
  const mode = pickMode();
  const reader = buildReader(mode);
  const server = createServer(reader);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`clean-ui-mcp server running on stdio (mode=${mode})`);
}

/**
 * Only auto-start when this module is the process entry point. The `bin` entry
 * (`dist/server.js`) and mcp-smoke.test.ts (which spawns `dist/server.js`
 * expecting auto-start + the readiness string) set argv[1] to this file, so
 * this guard preserves that behavior. Unit tests import `pickMode` directly;
 * without this guard, importing server.ts would open a stdio server as a side
 * effect — making the module untestable in isolation.
 */
const isMainModule = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] missing or unresolvable (e.g. some test runners) → don't start.
    return false;
  }
};

if (isMainModule()) {
  main().catch((err) => {
    console.error("Fatal error starting clean-ui-mcp:", err);
    process.exit(1);
  });
}
