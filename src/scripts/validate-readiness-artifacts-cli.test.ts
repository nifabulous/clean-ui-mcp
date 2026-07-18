import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("validate-readiness-artifacts CLI", () => {
  it("rejects the removed --previous-ledger option", () => {
    expect(() => execFileSync(process.execPath, [
      resolve("dist/scripts/validate-readiness-artifacts.js"),
      "--mode", "public",
      "--previous-ledger", "old.json",
    ], { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe" })).toThrow();
  });
});
