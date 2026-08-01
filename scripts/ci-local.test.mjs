import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/ci-local.sh");

function runWithFakeTools({ failCommand = "", browserPath = join(tmpdir(), "missing-chromium") } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "clean-ui-ci-local-"));
  const bin = join(fixtureRoot, "bin");
  mkdirSync(bin);

  // Keep the runner test-only: npm and node report the requested result without
  // rebuilding or executing the project's real gates.
  writeFileSync(
    join(bin, "npm"),
    "#!/bin/sh\n[ -n \"$CI_LOCAL_TEST_FAIL_COMMAND\" ] && [ \"$2\" = \"$CI_LOCAL_TEST_FAIL_COMMAND\" ] && exit 1\nexit 0\n",
  );
  writeFileSync(
    join(bin, "node"),
    "#!/bin/sh\n[ \"$1\" = \"-e\" ] && printf '%s' \"$CI_LOCAL_TEST_BROWSER_PATH\"\nexit 0\n",
  );
  writeFileSync(join(bin, "npx"), "#!/bin/sh\nexit 0\n");
  for (const name of ["npm", "node", "npx"]) chmodSync(join(bin, name), 0o755);

  try {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CI_LOCAL_TEST_BROWSER_PATH: browserPath,
        CI_LOCAL_TEST_FAIL_COMMAND: failCommand,
      },
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/g, "");
    return { ...result, output };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("ci-local shell runner", () => {
  it("warns when Playwright resolves no executable Chromium", () => {
    const result = runWithFakeTools();

    expect(result.status).toBe(0);
    expect(result.output).toContain("could not confirm Chromium is installed");
  });

  it.each(["site:test:browser", "site:test:browser:production"])(
    "does not label %s as jsdom contention",
    (command) => {
      const result = runWithFakeTools({ failCommand: command, browserPath: process.execPath });
      const expectedStep = command.endsWith(":production") ? 9 : 8;

      expect(result.status).toBe(1);
      expect(result.output).toContain(`FAILED at step ${expectedStep}/10: npm run ${command}`);
      expect(result.output).not.toContain("issue #84");
    },
  );

  it("keeps the jsdom contention hint for the exact site unit command", () => {
    const result = runWithFakeTools({ failCommand: "site:test", browserPath: process.execPath });

    expect(result.status).toBe(1);
    expect(result.output).toContain("issue #84");
  });

  it("keeps the local gate command list aligned with the workflow gate", () => {
    const localScript = readFileSync(SCRIPT, "utf8");
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const localCommands = [...localScript.matchAll(/^\s+\"(?:core|browser)\|([^\"]+)\"$/gm)].map(
      ([, command]) => command,
    );
    const workflowCommands = [...workflow.matchAll(/^\s+- run:\s+(.+)$/gm)].map(([, command]) => command.trim());
    const start = workflowCommands.indexOf("npm run validate-references");
    const end = workflowCommands.indexOf("node scripts/check-site-budget.mjs");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(localCommands).toEqual(workflowCommands.slice(start, end + 1));
  });
});
