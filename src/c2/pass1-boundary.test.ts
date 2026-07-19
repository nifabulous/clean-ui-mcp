/**
 * C2 Pass 1 scope boundary.
 *
 * Pass 1 landed contract schemas and the three-package pilot under
 * `eval/c2/pilot/` as *provisional* foundation work. It deliberately did NOT
 * activate readiness (no C2 recipe/policy, no approval, registry, index, or
 * ledger artifact) and it kept the pilot files out of the browser-downloadable
 * public assets. This suite pins all three guarantees so a future Pass 1 edit
 * cannot silently widen scope or re-open a public-exfiltration path.
 *
 * The test is intentionally an *inverse* gate: it asserts the ABSENCE of C2
 * governance activation and the ABSENCE of public-site pilot exposure. It is
 * expected to PASS while C2 is still open.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_RECIPES, CHECKPOINT_POLICIES } from "../readiness/checkpoint-policy.js";

const root = resolve(__dirname, "../..");

describe("C2 Pass 1 scope boundary", () => {
  it("does not activate a C2 checkpoint recipe or policy", () => {
    expect(Object.keys(CHECKPOINT_RECIPES).sort()).toEqual(["C0", "C1"]);
    expect(Object.keys(CHECKPOINT_POLICIES).sort()).toEqual(["C0", "C1"]);
  });

  it("creates no C2 approval, registry, index, or ledger artifact", () => {
    const governanceRoot = resolve(root, "quality-contracts/agent-readiness");
    const files = readdirSync(governanceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    for (const entry of files) {
      const tracked = readFileSync(resolve(entry.parentPath, entry.name), "utf8");
      expect(tracked).not.toMatch(/"checkpoint"\s*:\s*"C2"|"artifactType"\s*:\s*"c2-/);
    }
  });

  it("keeps pilot files outside browser-downloadable public assets", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "eval/c2/pilot/manifest.json"), "utf8"));
    for (const pkg of manifest.packages) {
      expect(pkg.brief.path.startsWith("eval/c2/pilot/")).toBe(true);
      expect(pkg.label.path.startsWith("eval/c2/pilot/")).toBe(true);
    }
  });
});
