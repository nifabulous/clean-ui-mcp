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
import { sha256Canonical, RECIPE_SHA256 } from "../create-ui-spec-contracts.js";
import recipe from "./fallback-recipe-v1.json" with { type: "json" };

/**
 * Frozen canonical-JSON SHA-256 of the recipe. Pinned from the checked-in
 * bytes of src/c3/fallback-recipe-v1.json. If the recipe changes, recompute
 * and replace this literal.
 *
 * This literal is kept as a belt-and-suspenders cross-check against
 * {@link RECIPE_SHA256} (the single source the envelope parser consumes); the
 * test below asserts they are equal so the two can never silently drift.
 */
const EXPECTED_RECIPE_SHA256 =
  "4c78f2f261b5d1e988e692d3b32a19762991a4eee0789734a54b3d6029d510f3";

describe("c3-fallback-v1 recipe identity", () => {
  it("has stable canonical bytes and recipe identity", () => {
    expect(recipe.recipeVersion).toBe("c3-fallback-v1");
    expect(sha256Canonical(recipe)).toBe(EXPECTED_RECIPE_SHA256);
    // The contracts module's RECIPE_SHA256 is the single source the envelope
    // parser consumes; it MUST agree with both the frozen literal and the
    // actual recipe bytes.
    expect(RECIPE_SHA256).toBe(EXPECTED_RECIPE_SHA256);
    expect(sha256Canonical(recipe)).toBe(RECIPE_SHA256);
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
    const ALLOWED = new Set([
      "corpus-observation",
      "public-reference",
      "recipe-system",
    ]);
    for (const kind of recipe.allowedEvidenceKinds as readonly string[]) {
      expect(ALLOWED.has(kind)).toBe(true);
    }
  });

  it("declares the recipe-editorial cited decision that matches the producer's emission", () => {
    // Drift guard: the recipe MUST honestly describe what the producer emits for
    // citedDecisions. The deterministic producer always emits ONE
    // editorial-authority designDirection decision grounded in the recipe/system
    // evidence (not corpus-evidence, since the direction echoes the brief). If
    // this test fails, the recipe and producer have diverged — reconcile one to
    // the other rather than silencing the test.
    const cited = (recipe.assemblyRules as { citedDecisions: {
      strategy: string;
      value: ReadonlyArray<{ field: string; authority: string; evidenceKind: string }>;
    } }).citedDecisions;
    expect(cited.strategy).toBe("recipe-editorial");
    expect(cited.value.length).toBe(1);
    expect(cited.value[0]!.field).toBe("designDirection");
    expect(cited.value[0]!.authority).toBe("editorial");
    expect(cited.value[0]!.evidenceKind).toBe("recipe-system");
  });

  it("declares a recipeEvidence block matching the producer's recipe/system evidence", () => {
    const rec = recipe.recipeEvidence as {
      id: string;
      kind: string;
      basis: string;
    };
    expect(rec.id).toMatch(/^evidence-[0-9]+$/);
    expect(rec.kind).toBe("recipe-system");
    expect(rec.basis).toBe("aggregate");
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
