/**
 * C2 Pass 1 scope boundary.
 *
 * Pass 1 landed contract schemas and the three-package pilot under
 * `eval/c2/pilot/` as provisional foundation work. C2 governance is now
 * declared separately by the readiness recipe and a hash-only evidence
 * manifest; the append-only human approvals remain separate ledger artifacts.
 * The pilot files remain outside browser-downloadable public assets.
 *
 * The tests pin the boundary between machine-verifiable C2 evidence and human
 * approval, as well as the absence of public-site pilot exposure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_RECIPES, CHECKPOINT_POLICIES } from "../readiness/checkpoint-policy.js";

const root = resolve(__dirname, "../..");

describe("C2 governance scope boundary", () => {
  it("declares C2 governance without claiming approval", () => {
    expect(Object.keys(CHECKPOINT_RECIPES).sort()).toEqual(["C0", "C1", "C2"]);
    expect(Object.keys(CHECKPOINT_POLICIES).sort()).toEqual(["C0", "C1", "C2"]);
  });

  it("tracks the evidence manifest and append-only approval ledgers", () => {
    const governanceRoot = resolve(root, "quality-contracts/agent-readiness");
    const manifest = JSON.parse(
      readFileSync(resolve(governanceRoot, "c2-evidence-manifest-v1.json"), "utf8"),
    );
    expect(manifest.artifactType).toBe("c2-evidence-manifest");
    expect(manifest.checkpoint).toBe("C2");
    expect(manifest.evidence).toHaveLength(8);
    expect(readdirSync(governanceRoot).filter((file) => file.match(/^checkpoint-approvals-v[345]\.json$/))).toEqual([
      "checkpoint-approvals-v3.json",
      "checkpoint-approvals-v4.json",
      "checkpoint-approvals-v5.json",
    ]);
    const ledger = JSON.parse(
      readFileSync(resolve(governanceRoot, "checkpoint-approvals-v5.json"), "utf8"),
    );
    expect(ledger.approvals.filter((approval: { checkpoint: string; supersedesApprovalId?: string }) => approval.checkpoint === "C2" && approval.supersedesApprovalId === undefined).map((approval: { role: string }) => approval.role)).toEqual([
      "Gold Label Owner",
      "QA",
    ]);
  });

  it("keeps pilot files outside browser-downloadable public assets", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "eval/c2/pilot/manifest.json"), "utf8"));
    for (const pkg of manifest.packages) {
      expect(pkg.brief.path.startsWith("eval/c2/pilot/")).toBe(true);
      expect(pkg.label.path.startsWith("eval/c2/pilot/")).toBe(true);
    }
  });
});
