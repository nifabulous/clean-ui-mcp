/**
 * fallback-recipe-v1.test.ts — pins the deterministic create-ui-spec
 * fallback recipe (c3-fallback-v1) by its canonical-JSON SHA-256.
 *
 * Task 2 of the C3 create-ui-spec first slice. The producer (Task 3) imports
 * this checked-in recipe directly via a NodeNext JSON import attribute, so the
 * test exercises the SAME import path (default import with
 * `with { type: "json" }`) and pins the artifact identity.
 *
 * The SHA literal below is frozen from the checked-in bytes: the recipe is
 * canonicalized via the repository's canonicalJsonStringify (sorted keys,
 * compact UTF-8) and hashed via sha256Hex. Any edit to the recipe MUST be
 * accompanied by an update to EXPECTED_RECIPE_SHA256.
 */
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../create-ui-spec-contracts.js";
import recipe from "./fallback-recipe-v1.json" with { type: "json" };

/**
 * Frozen canonical-JSON SHA-256 of the recipe. Pinned from the checked-in
 * bytes of src/c3/fallback-recipe-v1.json. If the recipe changes, recompute
 * and replace this literal.
 */
const EXPECTED_RECIPE_SHA256 =
  "1f86dc4aa8848c101680f2a8804c8a72c66ecaed204515e997c5ab14d3587099";

describe("c3-fallback-v1 recipe identity", () => {
  it("has stable canonical bytes and recipe identity", () => {
    expect(recipe.recipeVersion).toBe("c3-fallback-v1");
    expect(sha256Canonical(recipe)).toBe(EXPECTED_RECIPE_SHA256);
  });

  it("only emits warning codes the create_ui_spec tool documents", () => {
    const ALLOWED = new Set([
      "sparseCoverage",
      "insufficientCorpusEvidence",
      "motionEvidenceUnavailable",
      "authorityConflict",
    ]);
    for (const code of recipe.warningCodes as readonly string[]) {
      expect(ALLOWED.has(code)).toBe(true);
    }
  });

  it("only allows evidence kinds the contract permits", () => {
    const ALLOWED = new Set(["corpus-observation", "public-reference"]);
    for (const kind of recipe.allowedEvidenceKinds as readonly string[]) {
      expect(ALLOWED.has(kind)).toBe(true);
    }
  });

  it("declares color, typography, and motion as model-dependent and unavailable", () => {
    const fields = new Set(
      (recipe.unavailableDecisions as ReadonlyArray<{ field: string }>).map(
        (d) => d.field,
      ),
    );
    expect(fields.has("colorTokens")).toBe(true);
    expect(fields.has("typographyTokens")).toBe(true);
    expect(fields.has("motion")).toBe(true);
  });

  it("carries exactly one deterministic, offline acceptance criterion", () => {
    const criteria = recipe.acceptanceCriteria as ReadonlyArray<{
      verifier: string;
      manualSteps?: readonly string[];
    }>;
    expect(criteria.length).toBe(1);
    expect(criteria[0]!.verifier).toBe("manual");
    expect((criteria[0]!.manualSteps ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
