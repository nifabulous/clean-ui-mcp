import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";

// Regression for the ANSI-capture P1: Vite's colored CI output emits a
// color-reset sequence immediately after the preview URL. The browser suite's
// beforeAll parses that URL with /\S+/, which previously captured the trailing
// ANSI bytes — so the base-path normalization failed and /clean-ui-mcp got
// appended twice, producing an invalid URL that sank every browser test.
//
// This test pins the exact parse pipeline (strip VT → match → normalize) so a
// regression in the strip step fails here, not just in CI's browser run.

/** Mirror the production parse from site-browser.test.ts's onLine handler. */
function parseBaseUrl(rawChunk: string): string | null {
  const text = stripVTControlCharacters(rawChunk);
  const match = text.match(/https?:\/\/\S+/i);
  if (!match) return null;
  let url = match[0].replace(/\/+$/, "");
  if (!url.endsWith("/clean-ui-mcp")) url = `${url}/clean-ui-mcp`;
  return `${url}/`;
}

describe("vite preview URL parse (ANSI-stripped)", () => {
  it("parses a plain (uncolored) vite preview URL", () => {
    const line = "  ➜  Local:   http://localhost:4321/clean-ui-mcp/";
    expect(parseBaseUrl(line)).toBe("http://localhost:4321/clean-ui-mcp/");
  });

  it("parses a COLORED vite preview URL without capturing ANSI reset bytes", () => {
    // What CI actually sees: green URL + color-reset. \S+ alone would capture
    // the \u001b[39m, breaking the base-path check.
    const line =
      "  \u001b[32m➜\u001b[39m  \u001b[2mLocal:\u001b[22m   \u001b[32mhttp://localhost:37745/clean-ui-mcp/\u001b[39m";
    const result = parseBaseUrl(line);
    expect(result).toBe("http://localhost:37745/clean-ui-mcp/");
    // No ANSI bytes survive into the parsed URL.
    expect(result).not.toContain("\u001b");
    // No double-append of the base path.
    expect(result.match(/clean-ui-mcp/g)?.length).toBe(1);
  });

  it("appends the base path once when the printed URL omits it", () => {
    // Some Vite configs print the host root without the base path.
    const line = "  ➜  Local:   http://localhost:4321/";
    expect(parseBaseUrl(line)).toBe("http://localhost:4321/clean-ui-mcp/");
  });

  it("returns null when no URL is present", () => {
    expect(parseBaseUrl("  ➜  building for production...")).toBeNull();
  });
});
