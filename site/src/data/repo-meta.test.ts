import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoLinks, repoMeta } from "./repo-meta";

/**
 * Repository-link integrity.
 *
 * Every external GitHub destination on the public site must point at the
 * canonical repository. Six separate literals used to name an owner with no such
 * repository, so every external link on the shipped site 404'd. The links are now
 * derived from a single value (`repoMeta.repositoryUrl`); these tests pin that
 * value and prove the derivation is the only source of truth.
 */

// The canonical owner is the one README.md's clone command uses. It is asserted
// as a literal here deliberately: a test that derived the expectation from the
// same constant it is checking could not catch the owner being wrong.
const CANONICAL_REPOSITORY_URL = "https://github.com/nifabulous/clean-ui-mcp";

const SITE_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `github.com/<owner>/clean-ui-mcp` occurrence found under site/src. */
const REPO_URL_PATTERN = /github\.com\/([A-Za-z0-9._-]+)\/clean-ui-mcp/g;

/** Recursively list every file under `dir` (source only — no build output). */
function listFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("repoMeta.repositoryUrl", () => {
  it("defaults to the canonical repository", () => {
    expect(repoMeta.repositoryUrl).toBe(CANONICAL_REPOSITORY_URL);
  });
});

describe("repoLinks", () => {
  it("derives every destination from repoMeta.repositoryUrl", () => {
    for (const [name, url] of Object.entries(repoLinks)) {
      expect(url, `repoLinks.${name} must be derived from repositoryUrl`).toContain(
        repoMeta.repositoryUrl,
      );
    }
  });

  it("builds the README, releases, and anchor forms", () => {
    expect(repoLinks.repository).toBe(CANONICAL_REPOSITORY_URL);
    expect(repoLinks.readme).toBe(`${CANONICAL_REPOSITORY_URL}#readme`);
    expect(repoLinks.releases).toBe(`${CANONICAL_REPOSITORY_URL}/releases`);
    expect(repoLinks.connectClient).toBe(
      `${CANONICAL_REPOSITORY_URL}#connect-to-an-mcp-client`,
    );
    // The README heading is "## MCP tools (14)", so the slug carries the count.
    expect(repoLinks.mcpTools).toBe(
      `${CANONICAL_REPOSITORY_URL}#mcp-tools-${repoMeta.mcpToolCount}`,
    );
  });
});

describe("site source repository URLs", () => {
  it("never names an owner other than the one repoMeta resolves to", () => {
    // Scan SOURCE only. site/dist is a gitignored build artifact and contains
    // bundled copies of these strings.
    const expectedOwner = new URL(repoMeta.repositoryUrl).pathname.split("/")[1];
    expect(expectedOwner).toBeTruthy();

    const offenders: string[] = [];
    for (const file of listFiles(SITE_SRC)) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(REPO_URL_PATTERN)) {
        if (match[1] !== expectedOwner) {
          offenders.push(`${file.slice(SITE_SRC.length + 1)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
