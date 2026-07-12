#!/usr/bin/env node
/**
 * server.ts — the executable entry point for the clean-ui-mcp server.
 *
 * Gate 1A, Task 4a (F7). This module is intentionally tiny: it reads the
 * mode from `CLEAN_UI_MODE`, constructs the appropriate `CorpusReader`,
 * calls `createServer(reader)` (from server-factory.ts), connects a stdio
 * transport, and logs the readiness signal. All tool registration lives in
 * server-factory.ts now — importing THIS module is what starts a server and
 * opens stdio; importing server-factory.ts does NOT.
 *
 * Mode selection: `CLEAN_UI_MODE` env var. Defaults to `"private"` when
 * absent (so the smoke test, which sets no mode, runs against the full
 * private corpus exactly as before). `"public"` is reserved for Task 4b's
 * PublicCorpusReader — until that lands, an explicit `"public"` mode falls
 * back to private with a stderr warning so the server still boots.
 *
 * The `bin` entry (`dist/server.js`) and mcp-smoke.test.ts (which spawns
 * `dist/server.js` expecting auto-start + the readiness string) depend on
 * the bottom-of-module `main()` call — keep it.
 */
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server-factory.js";
import { PrivateCorpusReader, type CorpusMode } from "./corpus-reader.js";

function pickMode(): CorpusMode {
  const raw = process.env.CLEAN_UI_MODE;
  if (raw === "public" || raw === "private") return raw;
  // Absent or unrecognized → private (the historical default). This keeps the
  // smoke test (which sets no mode) working unchanged.
  return "private";
}

async function main(): Promise<void> {
  const mode = pickMode();
  // PublicCorpusReader is Task 4b. Until it lands, an explicit "public" mode
  // falls back to private so the server still boots and lists tools.
  const reader = new PrivateCorpusReader();
  if (mode === "public") {
    console.error("[clean-ui-mcp] CLEAN_UI_MODE=public requested but PublicCorpusReader is not yet implemented (Task 4b); falling back to private mode.");
  }
  const server = createServer(reader);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("clean-ui-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting clean-ui-mcp:", err);
  process.exit(1);
});
