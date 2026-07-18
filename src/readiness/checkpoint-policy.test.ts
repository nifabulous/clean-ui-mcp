import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  C0_RECIPE,
  C1_CONTRACT_SHA,
  C1_MERGE_SHA,
  C1_RECIPE,
  CHECKPOINT_POLICIES,
  CHECKPOINT_RECIPES,
} from "./checkpoint-policy.js";

describe("checkpoint recipes", () => {
  it("records reviewed C1 content separately from merge provenance", () => {
    expect(C1_CONTRACT_SHA).toBe("022a3f229a4aeba74b9b140142fd2d3a0aa6c4be");
    expect(C1_MERGE_SHA).toBe("7609e3c14daddd4448d6bdf37c9a6a337a7241d0");
    expect(C1_RECIPE.sourceGitSha).toBe(C1_CONTRACT_SHA);
    expect(CHECKPOINT_RECIPES).toEqual({ C0: C0_RECIPE, C1: C1_RECIPE });
  });

  it("binds every C1 contract source to the reviewed commit", () => {
    expect(C1_RECIPE.contractBindings.map((b) => b.repositoryPath)).toEqual([
      "src/tool-contracts.ts",
      "src/tool-contract-integrity.ts",
      "src/tool-contract-docs.ts",
      "src/tool-catalog.ts",
    ]);
    expect(C1_RECIPE.contractBindings.every((b) => b.gitCommit === C1_CONTRACT_SHA)).toBe(true);
  });

  it("keeps reviewed and merged source bytes identical", () => {
    const paths = [
      C1_RECIPE.planBinding.repositoryPath,
      C1_RECIPE.specBinding.repositoryPath,
      ...C1_RECIPE.contractBindings.map((b) => b.repositoryPath),
    ];
    for (const path of paths) {
      const reviewed = execFileSync("git", ["show", `${C1_CONTRACT_SHA}:${path}`]);
      const merged = execFileSync("git", ["show", `${C1_MERGE_SHA}:${path}`]);
      expect(merged.equals(reviewed), path).toBe(true);
    }
  });

  it("declares exact closed-world policies", () => {
    expect(CHECKPOINT_POLICIES.C0.requiredRoles).toEqual(["Repository Maintainer", "PM"]);
    expect(CHECKPOINT_POLICIES.C1.requiredRoles).toEqual(["Product", "Engineering"]);
    expect(CHECKPOINT_POLICIES.C1.requiredContractKeys).toEqual(
      C1_RECIPE.contractBindings.map((b) => b.key),
    );
    expect(CHECKPOINT_POLICIES.C1.requiredArtifactTypes).toEqual([
      "approval-actor-registry",
      "artifact-index",
    ]);
  });
});
