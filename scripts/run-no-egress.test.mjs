import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "run-no-egress.mjs");

describe("run-no-egress", () => {
  it("passes through a successful command with redacted env", () => {
    const result = execFileSync("node", [SCRIPT, "--", "echo", "hello"], {
      encoding: "utf-8",
      env: { ...process.env, OPENAI_API_KEY: "secret-that-must-not-leak" },
    });
    // stdout from echo goes to the child's inherit, stderr has the no-egress log
    expect(result).toContain("hello");
  });

  it("exits non-zero when the command fails", () => {
    expect(() => {
      execFileSync("node", [SCRIPT, "--", "false"], { encoding: "utf-8" });
    }).toThrow();
  });

  it("exits with usage error when no command given", () => {
    expect(() => {
      execFileSync("node", [SCRIPT], { encoding: "utf-8" });
    }).toThrow();
  });
});
