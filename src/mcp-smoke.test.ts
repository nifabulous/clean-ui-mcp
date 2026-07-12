/**
 * mcp-smoke.test.ts — end-to-end MCP server smoke test.
 *
 * Starts the actual MCP server as a child process (stdio transport), lists
 * all tools via the MCP protocol, and calls a read-only tool. Verifies:
 * - Server boots and responds to MCP JSON-RPC
 * - All 14 tools are discoverable via tools/list
 * - A read-only tool (list_categories) returns valid structured output
 *
 * No provider credentials required — the server boots and lists tools even
 * without API keys (tool discovery doesn't need a corpus or provider).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const SERVER_PATH = resolve(import.meta.dirname ?? __dirname, "..", "dist", "server.js");

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

  it("responds to tools/list with all 14 tools", async () => {
    const resp = await rpc("tools/list");
    expect(resp.error).toBeUndefined();
    const result = resp.result as { tools?: Array<{ name: string }> };
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(14);

    const names = result.tools!.map((t) => t.name);
    // Verify all expected tool names are present
    const expected = [
      "search_ui_examples", "get_ui_example", "list_categories", "list_style_tags",
      "list_domain_tags", "get_similar_ui_examples", "compare_ui_examples",
      "generate_design_prompt", "recommend_ui_direction", "get_anti_patterns",
      "get_color_palette", "get_stealable_techniques", "browse_ui_examples",
      "critique_ui",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
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
