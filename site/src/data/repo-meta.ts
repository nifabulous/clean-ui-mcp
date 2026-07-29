/**
 * Verified repository metadata for the public site.
 *
 * These values describe the project itself (license, MCP tool count) — never
 * adoption, customer, or usage metrics (spec §15 out-of-scope). They are sourced
 * from verifiable repository facts (package.json `license`, the README's tool
 * list) and surfaced here as literals so they can be audited in one place.
 *
 * If `VITE_REPO_*` build-time overrides are provided, they take precedence; the
 * defaults are the verified values committed in the repository.
 */
export interface RepoMeta {
  /** SPDX license identifier from package.json. Verified value: "MIT". */
  readonly license: string;
  /** Number of MCP tools the server exposes. Verified from the README tool list. */
  readonly mcpToolCount: number;
  /** Canonical npm package name. */
  readonly packageName: string;
  /** Repository URL (used for the open-source/reliability section + nav). */
  readonly repositoryUrl: string;
}

function readString(name: string, fallback: string): string {
  const value = import.meta.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = import.meta.env[name];
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Resolved repository metadata. All defaults are verified repository facts. */
export const repoMeta: RepoMeta = {
  license: readString("VITE_REPO_LICENSE", "MIT"),
  mcpToolCount: readNumber("VITE_REPO_MCP_TOOL_COUNT", 14),
  packageName: readString("VITE_REPO_PACKAGE_NAME", "clean-ui-mcp"),
  repositoryUrl: readString(
    "VITE_REPO_URL",
    "https://github.com/nifabulous/clean-ui-mcp",
  ),
};

/** `repositoryUrl` without a trailing slash, so derived paths join cleanly. */
const repoBaseUrl = repoMeta.repositoryUrl.replace(/\/+$/, "");

/**
 * Every external repository destination the site links to, derived from the one
 * `repoMeta.repositoryUrl` value.
 *
 * These were previously six independent literals, all naming an owner that does
 * not exist — so every external link on the shipped site 404'd, and no single
 * fix could have caught the other five. Deriving them means one value to verify.
 *
 * The README anchors are GitHub heading slugs: `## Connect to an MCP client` →
 * `#connect-to-an-mcp-client`, and `## MCP tools (14)` → `#mcp-tools-14` (so the
 * tools anchor carries `mcpToolCount`, keeping the link and its label in step).
 */
export const repoLinks = {
  /** Repository root. */
  repository: repoBaseUrl,
  /** README (the site's Docs destination). */
  readme: `${repoBaseUrl}#readme`,
  /** Releases (the site's Changelog destination). */
  releases: `${repoBaseUrl}/releases`,
  /** README § Connect to an MCP client. */
  connectClient: `${repoBaseUrl}#connect-to-an-mcp-client`,
  /** README § MCP tools (<count>). */
  mcpTools: `${repoBaseUrl}#mcp-tools-${repoMeta.mcpToolCount}`,
} as const;
