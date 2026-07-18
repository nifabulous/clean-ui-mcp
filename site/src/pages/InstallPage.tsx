import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { CopyAction } from "../components/CopyAction";
import { repoMeta } from "../data/repo-meta";
import "../styles/install.css";

/**
 * Install guide (spec §6.2 + the plan's Task 4 Step 6).
 *
 * Shows the canonical npm command and the MCP server configuration, each with a
 * CopyAction (with a clipboard fallback). Links out to the README/Docs for
 * client-specific configuration details rather than duplicating volatile
 * per-client instructions (Claude Desktop path, VS Code, etc.).
 */
const NPM_COMMAND = "npm i clean-ui-mcp";

// Canonical MCP config. The path is a documented placeholder the user replaces
// with their absolute build output path (matches the README's example).
const MCP_CONFIG = `{
  "mcpServers": {
    "clean-ui": {
      "command": "node",
      "args": ["/absolute/path/to/clean-ui-mcp/dist/server.js"]
    }
  }
}`;

export function InstallPage(): ReactElement {
  return (
    <div className="install">
      <p className="install__eyebrow">Install</p>
      <h1>
        Connect clean-ui to your <em>agent</em>
      </h1>
      <p className="install__lede">
        clean-ui-mcp is a Model Context Protocol server. Install the package, build once, and point
        any MCP-compatible client at the server. It speaks stdio and exposes the tools your agent
        calls to search the corpus.
      </p>

      {/* Step 1: install + build */}
      <section className="install__step" aria-labelledby="install-step-install">
        <div className="install__step-head">
          <span className="install__step-num">Step 1</span>
          <h2 id="install-step-install">Install and build</h2>
        </div>
        <p>Install the package, then build the server once so <code>dist/server.js</code> exists:</p>
        <div className="install__code">
          <code className="install__code-text">{NPM_COMMAND}</code>
          <span className="install__copy">
            <CopyAction value={NPM_COMMAND} label="Copy install command" />
          </span>
        </div>
        <p className="install__note">Then, from the package directory, run <code>npm run build</code>.</p>
      </section>

      {/* Step 2: MCP config */}
      <section className="install__step" aria-labelledby="install-step-config">
        <div className="install__step-head">
          <span className="install__step-num">Step 2</span>
          <h2 id="install-step-config">Register the MCP server</h2>
        </div>
        <p>
          Add this to your client&rsquo;s MCP configuration. Replace the path with the absolute path
          to your built <code>dist/server.js</code>:
        </p>
        <div className="install__code install__code--block">
          <pre className="install__code-text">{MCP_CONFIG}</pre>
          <span className="install__copy">
            <CopyAction value={MCP_CONFIG} label="Copy MCP config" />
          </span>
        </div>
        <p className="install__note">Client-specific details live in the docs (they change often):</p>
        <ul className="install__clients">
          <li>
            <a
              href="https://github.com/olaniyi-oladokun/clean-ui-mcp#connect-to-an-mcp-client"
              rel="noreferrer noopener"
              target="_blank"
            >
              Connect to an MCP client (README)
            </a>{" "}
            — Claude Desktop, Claude Code, and others.
          </li>
          <li>
            <a
              href="https://github.com/olaniyi-oladokun/clean-ui-mcp#mcp-tools-14"
              rel="noreferrer noopener"
              target="_blank"
            >
              The {repoMeta.mcpToolCount} MCP tools (README)
            </a>{" "}
            — what your agent can call.
          </li>
        </ul>
      </section>

      <section className="install__next" aria-labelledby="install-next">
        <h2 id="install-next">Then explore the corpus</h2>
        <p>
          No keys are required to start — the server serves keyword search over the shipped corpus
          out of the box. Open the Playground to see the same search your agent will use.
        </p>
        <div className="install__actions">
          <Link className="install__action--primary" to="/playground">
            Try the Playground
          </Link>
          <a
            className="install__action--secondary"
            href={repoMeta.repositoryUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            View on GitHub
          </a>
        </div>
      </section>
    </div>
  );
}
