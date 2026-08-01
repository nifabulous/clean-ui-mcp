import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  C0_RECIPE,
  C1_CONTRACT_SHA,
  C1_MERGE_SHA,
  C1_RECIPE,
  C3_RECIPE,
  C3_SOURCE_GIT_SHA,
  CHECKPOINT_POLICIES,
  CHECKPOINT_RECIPES,
} from "./checkpoint-policy.js";

describe("checkpoint recipes", () => {
  it("records reviewed C1 content separately from merge provenance", () => {
    expect(C1_CONTRACT_SHA).toBe("022a3f229a4aeba74b9b140142fd2d3a0aa6c4be");
    expect(C1_MERGE_SHA).toBe("7609e3c14daddd4448d6bdf37c9a6a337a7241d0");
    expect(C1_RECIPE.sourceGitSha).toBe(C1_CONTRACT_SHA);
    expect(CHECKPOINT_RECIPES).toHaveProperty("C0", C0_RECIPE);
    expect(CHECKPOINT_RECIPES).toHaveProperty("C1", C1_RECIPE);
    expect(CHECKPOINT_RECIPES).toHaveProperty("C2");
    expect(CHECKPOINT_RECIPES).toHaveProperty("C3", C3_RECIPE);
  });

  it("anchors the C3 slice at the reviewed head commit, without merge provenance", () => {
    expect(C3_SOURCE_GIT_SHA).toBe("5255a656cc35763b73d85c5eabb401e3bde9714d");
    expect(C3_RECIPE.sourceGitSha).toBe(C3_SOURCE_GIT_SHA);
    // The slice landed across multiple commits (unlike C1's single merge), so
    // no integrationGitSha is recorded and no reviewed-vs-merged comparison
    // applies. Later hardening commits are post-review by design.
    expect(C3_RECIPE.integrationGitSha).toBeUndefined();
  });

  it("binds every C3 slice contract source to the reviewed commit", () => {
    // Both the wiring surface AND the create_ui_spec implementation. A file
    // hash covers only its own bytes, not its imports, so binding only the
    // wiring would leave the canonical target invariant to core-logic changes.
    expect(C3_RECIPE.contractBindings.map((b) => b.repositoryPath)).toEqual([
      // Wiring surface.
      "src/tool-contracts.ts",
      "src/server-factory.ts",
      "src/scripts/ui-server.ts",
      "site/src/app/App.tsx",
      "skill/clean-ui-design/SKILL.md",
      // create_ui_spec implementation.
      "src/create-ui-spec.ts",
      "src/create-ui-spec-contracts.ts",
      "src/create-ui-spec-mcp.ts",
      "src/create-ui-spec-http.ts",
      "src/create-ui-spec-dependencies.ts",
      "src/create-ui-spec-transport-errors.ts",
      "src/c3/safe-aggregator.ts",
      "src/c3/fallback-recipe-v1.json",
    ]);
    expect(C3_RECIPE.contractBindings.every((b) => b.gitCommit === C3_SOURCE_GIT_SHA)).toBe(true);
    expect(C3_RECIPE.planBinding.gitCommit).toBe(C3_SOURCE_GIT_SHA);
    expect(C3_RECIPE.specBinding.gitCommit).toBe(C3_SOURCE_GIT_SHA);
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
    // `.github/workflows/ci.yml` checks out with `fetch-depth: 0`, so both the
    // branch commit (C1_CONTRACT_SHA) and the merge commit (C1_MERGE_SHA) ARE
    // reachable on CI and this comparison really runs there. The guard below
    // stays for other environments that may hand us a shallow clone or no
    // history at all (an exported tarball, `--depth 1` locally): the recipe SHA
    // constants are content hashes the validator resolves at runtime through the
    // injected GitSourceResolver, so this cross-commit byte comparison is a
    // local corroboration rather than the enforcement point. Do NOT copy this
    // self-skip into src/readiness/tracked-artifacts-readiness.test.ts — that
    // suite IS the enforcement point for C2-open and must fail, not skip, when
    // it cannot resolve its commits.
    for (const sha of [C1_CONTRACT_SHA, C1_MERGE_SHA]) {
      try {
        execFileSync("git", ["cat-file", "-e", sha], { stdio: "pipe" });
      } catch {
        return; // shallow clone — skip the cross-commit byte comparison
      }
    }

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
    expect(CHECKPOINT_POLICIES.C2.requiredRoles).toEqual(["Gold Label Owner", "QA"]);
    expect(CHECKPOINT_POLICIES.C2.requiredArtifactTypes).toEqual([
      "approval-actor-registry",
      "artifact-index",
      "c2-evidence-manifest",
    ]);
    expect(CHECKPOINT_POLICIES.C3.requiredRoles).toEqual(["Product", "QA", "Engineering"]);
    expect(CHECKPOINT_POLICIES.C3.requiredArtifactTypes).toEqual([
      "approval-actor-registry",
      "artifact-index",
    ]);
  });
});
