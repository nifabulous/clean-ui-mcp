/**
 * C2 barrel collision guard.
 *
 * `src/c2/index.ts` re-exports the full C2 surface. The Pass 2 modules
 * (`candidate-contracts.ts`, `condition-contracts.ts`) must not re-export the
 * primitives they consume, otherwise a name collision appears once both the
 * primitive module and the new modules are re-exported through the barrel.
 * TypeScript rejects duplicate `export *` names at compile time, but this test
 * pins the guarantee at runtime so a future edit cannot reintroduce a clash by
 * re-exporting primitives from a Pass 2 module.
 */
import { describe, expect, it } from "vitest";
import * as candidateModule from "./candidate-contracts.js";
import * as conditionModule from "./condition-contracts.js";
import * as c2Index from "./index.js";

const PRIMITIVE_EXPORT_NAMES = new Set<string>([
  // primitives.ts
  "NonEmptyText",
  "StableId",
  "PositiveVersion",
  "RepoRelativePath",
  "C2_CASE_FAMILIES",
  "C2CaseFamilySchema",
  "C2_CONTROL_CONDITIONS",
  "C2ControlConditionSchema",
  "AuthorityLaneSchema",
  "ArtifactFileRefSchema",
  "hasUniqueStrings",
  "UniqueNonEmptyStrings",
  // readiness/contracts.ts re-exported through primitives/case contracts
  "Sha256",
  "GitSha",
]);

describe("C2 barrel", () => {
  it("re-exports every new Pass 2 schema exactly once", () => {
    expect(c2Index.C2CandidateArtifactSchema).toBeDefined();
    expect(c2Index.C2DeterministicScoreSchema).toBeDefined();
    expect(c2Index.C2ConditionInputSchema).toBeDefined();
    expect(c2Index.C2CampaignConfigSchema).toBeDefined();
    expect(c2Index.C2PricingTableSchema).toBeDefined();
    expect(c2Index.C2BlindScoreSubmissionSchema).toBeDefined();
    expect(c2Index.C2CalibrationProposalSchema).toBeDefined();
    expect(c2Index.C2FrozenCalibrationSchema).toBeDefined();
    expect(c2Index.C2EvaluationRunManifestV1Schema).toBeDefined();
    expect(c2Index.C2EvaluationRunManifestV2Schema).toBeDefined();
    expect(c2Index.C2EvaluationRunManifestSchema).toBeDefined();
  });

  it("keeps the V1 compatibility alias equal to the V1 schema", () => {
    expect(c2Index.C2EvaluationRunManifestSchema).toBe(c2Index.C2EvaluationRunManifestV1Schema);
  });

  it("does not re-export primitives from the Pass 2 contract modules", () => {
    for (const [moduleName, moduleExports] of [
      ["candidate-contracts", candidateModule],
      ["condition-contracts", conditionModule],
    ] as const) {
      const exportNames = Object.keys(moduleExports);
      const collisions = exportNames.filter((name) => PRIMITIVE_EXPORT_NAMES.has(name));
      expect(collisions).toEqual([]);
    }
  });
});
