/**
 * mcp-smoke.test.ts — end-to-end MCP server smoke test.
 *
 * Starts the actual MCP server as a child process (stdio transport), lists
 * all tools via the MCP protocol, and calls a read-only tool. Verifies:
 * - The compiled artifact under test is a CURRENT build of `src/` (see below)
 * - Server boots and responds to MCP JSON-RPC
 * - All 14 tools are discoverable via tools/list
 * - A read-only tool (list_categories) returns valid structured output
 *
 * No provider credentials required — the server boots and lists tools even
 * without API keys (tool discovery doesn't need a corpus or provider).
 *
 * ─── WHY THE BUILD-CURRENCY GUARD EXISTS (Task 4 of the C3 slice) ────────────
 *
 * This is the ONE suite in the repository that tests a COMPILED artifact
 * (`dist/server.js`) rather than the TypeScript sources vitest transforms. `dist/`
 * is gitignored and nothing in the `npm test` path rebuilds it, so before this
 * guard the suite could validate a STALE build and report green while `src/` said
 * something different. That is exactly what happened at Task 3: public
 * `generate_design_prompt` was deregistered and `create_ui_spec` registered in
 * `src/server-factory.ts`, `npm test` reported fully green against the old
 * `dist/`, and the real failure only appeared after a rebuild.
 *
 * A false green here is worse than no test: it actively asserts a contract the
 * shipped code no longer honours. So {@link assertCompiledServerIsCurrent}
 * compares the newest mtime under `src/` (excluding `*.test.ts`, which are not
 * emitted) against the newest mtime of the emitted `dist/**\/*.js`. `tsc` in this
 * repo is non-incremental and rewrites every output on every build, so the
 * newest `dist` mtime IS the build time; comparing max-to-max also stays correct
 * if a future config makes emit per-file incremental. If any source is newer, the
 * suite FAILS with the rebuild command instead of silently testing yesterday's
 * server.
 *
 * The tool-list assertion below is a second, narrower currency marker: the exact
 * approved public set (including `generate_design_prompt` being ABSENT) is only
 * satisfiable by a build that includes Task 3's registration change.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  assertCompiledServerIsCurrent as assertCompiledServerIsCurrentFor,
  type NewestFileInfo,
} from "./build-currency.js";
import {
  BUILD_CURRENCY_SRC_MTIME_ENV,
  BUILD_CURRENCY_SRC_PATH_ENV,
} from "./build-currency-global-setup.js";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const SRC_DIR = resolve(REPO_ROOT, "src");
const DIST_DIR = resolve(REPO_ROOT, "dist");
const SERVER_PATH = resolve(DIST_DIR, "server.js");

/**
 * Reads the pre-test-run source-mtime snapshot published by
 * build-currency-global-setup.ts's `setup()` (see vitest.config.ts's
 * `globalSetup`). Throws — rather than falling back to a live re-scan under
 * `SRC_DIR` — if the env var is entirely unset, because a silent fallback
 * would quietly reintroduce the order-dependent bug this file exists to fix:
 * `src/references/generated.ts` is a tracked source file that
 * `src/references/generated.test.ts` rewrites mid-suite (write "// drift"
 * then restore, for its own drift-detection assertions), so a live re-scan at
 * assertion time reports STALE BUILD or not depending purely on whether that
 * rewrite already ran.
 */
function readSourceSnapshotFromEnv(): NewestFileInfo | null {
  const mtimeRaw = process.env[BUILD_CURRENCY_SRC_MTIME_ENV];
  if (mtimeRaw === undefined) {
    throw new Error(
      `Build-currency snapshot missing: ${BUILD_CURRENCY_SRC_MTIME_ENV} is unset. This suite requires ` +
      `vitest.config.ts's globalSetup ["./src/build-currency-global-setup.ts"] to run before any test ` +
      `file — if you invoked Vitest with a config that omits it, add it back rather than computing ` +
      `src/ mtime live here (that reintroduces the order-dependent STALE BUILD bug fixed by this ` +
      `snapshot mechanism).`,
    );
  }
  if (mtimeRaw === "") return null; // globalSetup ran and found no emitted source under src/
  const path = process.env[BUILD_CURRENCY_SRC_PATH_ENV] ?? "<unknown>";
  return { path, mtimeMs: Number(mtimeRaw) };
}

/**
 * Fail loudly when `dist/` is missing or older than the pre-captured `src/`
 * snapshot (see readSourceSnapshotFromEnv above for why it's a snapshot, not
 * a live re-scan). Called from `beforeAll` (so a stale build cannot be
 * silently exercised by any test in this file) and asserted again as a named
 * test (so the report says WHY).
 *
 * This is a heuristic, not a proof of correctness: erring toward a loud false
 * ALARM over a silent false green is the right trade here, but the mtime
 * comparison has three undocumented false-PASS modes where it stays quiet over
 * a build that does not actually match `src/`:
 *  (a) a source file DELETED from `src/` leaves its stale `dist/*.js` in
 *      place and bumps no `src` mtime — max-src stays older than max-dist, so
 *      the guard is satisfied by a `dist/` containing a module that no longer
 *      exists;
 *  (b) a system clock moved BACKWARD makes a genuinely newer edit carry an
 *      older mtime than the build it should invalidate;
 *  (c) an mtime-PRESERVING restore (e.g. `rsync --times`, some tarball
 *      extractions) changes file content without advancing mtime at all.
 * None of these are proof the compiled server matches `src/` — only that the
 * timestamps did not disagree. The narrower tool-list marker below (the exact
 * 14-name set with `generate_design_prompt` absent) backstops the case that
 * matters most, but does not close the general gap; an exact answer would
 * need a content-hash manifest, which this suite does not maintain.
 */
function assertCompiledServerIsCurrent(): void {
  assertCompiledServerIsCurrentFor({
    srcDir: SRC_DIR,
    distDir: DIST_DIR,
    sourceSnapshot: readSourceSnapshotFromEnv(),
  });
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

describe("MCP server smoke test", () => {
  let server: ChildProcess | null = null;
  let nextId = 1;

  // Send a JSON-RPC request and wait for the response with the matching id.
  function rpc(method: string, params?: unknown): Promise<MCPResponse> {
    return new Promise((resolveRpc, reject) => {
      const id = nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const line = msg + "\n";

      const onData = (data: Buffer) => {
        const text = data.toString();
        // The server may emit stderr logs mixed with stdout — find the JSON line
        for (const l of text.split("\n")) {
          if (!l.trim()) continue;
          try {
            const parsed = JSON.parse(l) as MCPResponse;
            if (parsed.id === id) {
              server?.stdout?.off("data", onData);
              resolveRpc(parsed);
              return;
            }
          } catch {
            // Not JSON (likely a log line on stderr) — skip
          }
        }
      };

      server?.stdout?.on("data", onData);
      server?.stdin?.write(line);

      // Timeout after 10s
      setTimeout(() => {
        server?.stdout?.off("data", onData);
        reject(new Error(`MPC request "${method}" timed out after 10s`));
      }, 10_000);
    });
  }

  beforeAll(async () => {
    // FIRST: refuse to exercise a stale compiled artifact. Every test in this
    // file asserts something about `dist/server.js`; if that build predates
    // `src/`, a green run is a lie. Throwing here fails the whole suite with the
    // rebuild instruction rather than passing against yesterday's server.
    assertCompiledServerIsCurrent();

    // Start the server as a child process
    server = spawn("node", [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENAI_API_KEY: "" }, // no keys needed for tool discovery
    });

    // Wait for the server to signal readiness (stderr: "clean-ui-mcp server running on stdio")
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error("Server didn't start in 10s")), 10_000);
      server?.stderr?.on("data", (data: Buffer) => {
        if (data.toString().includes("running on stdio")) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
    });
  }, 15_000);

  afterAll(async () => {
    server?.kill();
    // Give it a moment to clean up
    await new Promise((r) => setTimeout(r, 200));
  });

  it("the compiled server under test is a current build of src/", () => {
    // Named so a stale `dist/` reports the actual cause. `beforeAll` already ran
    // the same check (so no other test in this file can pass against a stale
    // build); this restates it as its own assertion for the test report.
    expect(() => assertCompiledServerIsCurrent()).not.toThrow();
  });

  it("responds to tools/list with all 14 tools", async () => {
    const resp = await rpc("tools/list");
    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools?: Array<{ name: string }> };
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(14);

    const names = result.tools!.map((t) => t.name);
    // The EXACT approved public set. `create_ui_spec` replaced public
    // `generate_design_prompt` in Task 3 of the C3 slice — the total stays 14
    // (one name swapped, nothing added or removed).
    const expected = [
      "search_ui_examples", "get_ui_example", "list_categories", "list_style_tags",
      "list_domain_tags", "get_similar_ui_examples", "compare_ui_examples",
      "create_ui_spec", "recommend_ui_direction", "get_anti_patterns",
      "get_color_palette", "get_stealable_techniques", "browse_ui_examples",
      "critique_ui",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    // Set equality, not just containment: with the count pinned at 14 and all 14
    // expected names present, an unexpected name cannot hide.
    expect([...names].sort()).toEqual([...expected].sort());

    // `generate_design_prompt` is DEREGISTERED as a public tool. Asserted
    // explicitly (not merely implied by the set equality above) because this is
    // the deregistration's only end-to-end proof over the real protocol:
    // `LEGACY_TO_BETA_MAP["generate_design_prompt"]` deliberately still exists as
    // the migration table row, so "the name appears in the codebase" is expected —
    // "the name is callable as a public tool" is not.
    expect(names).not.toContain("generate_design_prompt");
  }, 15_000);

  it("rejects a tools/call for the deregistered generate_design_prompt", async () => {
    // The complement of the tools/list assertion: absence from the listing and
    // absence from the CALL surface are different claims, and only the second one
    // proves the tool cannot be invoked by a client that already knew the name.
    const resp = await rpc("tools/call", {
      name: "generate_design_prompt",
      arguments: { ids: ["anything"] },
    });
    expect(resp.jsonrpc).toBe("2.0");
    const errored =
      resp.error !== undefined ||
      (resp.result as { isError?: boolean } | undefined)?.isError === true;
    expect(errored, `generate_design_prompt must not be callable: ${JSON.stringify(resp).slice(0, 400)}`).toBe(true);
  }, 15_000);

  it("responds to tools/call for create_ui_spec (no corpus, no credentials)", async () => {
    // The registration Task 3 added must be reachable over the REAL stdio
    // protocol from the compiled artifact — the transport-level contract suite
    // (create-ui-spec-mcp.test.ts) runs in-process over InMemoryTransport, so
    // this is the only check that the compiled server serves the tool at all.
    const resp = await rpc("tools/call", {
      name: "create_ui_spec",
      arguments: { productContext: "A calm analytics dashboard for a fintech team" },
    });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: { tool?: string };
    };
    expect(result.content).toBeDefined();
    expect(result.content!.length).toBeGreaterThan(0);
    expect(result.content![0].type).toBe("text");
    // Whether the local corpus yields matches or the deterministic fallback, the
    // envelope is the shared one and names this tool.
    expect(result.structuredContent?.tool).toBe("create_ui_spec");
  }, 15_000);

  it("responds to tools/call for list_categories (read-only, no corpus needed)", async () => {
    const resp = await rpc("tools/call", {
      name: "list_categories",
      arguments: {},
    });
    // The server may return an error if the corpus isn't loaded, but the
    // response itself must be valid JSON-RPC with the right id.
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.result).toBeDefined();
    // result should have content array
    const result = resp.result as { content?: Array<{ type: string; text: string }> };
    expect(result.content).toBeDefined();
    expect(result.content!.length).toBeGreaterThan(0);
    expect(result.content![0].type).toBe("text");
  }, 15_000);
});
