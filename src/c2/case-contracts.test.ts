import { describe, expect, it } from "vitest";
import {
  C2CaseBriefSchema,
  C2DecisionLabelSchema,
  C2CasePackageManifestSchema,
  C2PilotManifestSchema,
} from "./case-contracts.js";

const SHA = "a".repeat(64);

function fileRef(artifactId: string, path: string) {
  return { artifactId, path, sha256: SHA };
}

const brief = {
  schemaVersion: "1.0",
  artifactType: "c2-case-brief",
  artifactId: "c2-brief-stablecoin-home-v1",
  caseId: "stablecoin-home",
  caseVersion: 1,
  family: "product",
  stratum: "stablecoin-marketing",
  title: "B2B stablecoin on/off-ramp homepage",
  productContext: "Fictional early-stage infrastructure provider serving businesses first and fintech integrators second.",
  users: ["cross-border payments lead", "fintech integration lead"],
  jobs: ["understand the service", "request access", "find integration information"],
  platform: "responsive-web",
  requiredJourneys: ["business visitor to request-access form", "integrator to developer overview"],
  constraints: ["Do not claim licences, corridors, rates, or settlement times not supplied in the brief."],
  requiredScreens: [{ id: "home", states: ["default", "request-access-success"], mobileRules: ["single-primary-action"] }],
  sourceSnapshotRef: null,
};

const label = {
  schemaVersion: "1.0",
  artifactType: "c2-decision-label",
  artifactId: "c2-label-stablecoin-home-v1",
  caseId: "stablecoin-home",
  caseVersion: 1,
  labelVersion: 2,
  requiredSections: ["globalDirection", "screenBlueprints", "acceptanceCriteria", "assumptions", "authorityLanes", "sourceDecisions"],
  requiredDecisionIds: ["decision:audience-hierarchy"],
  requiredAcceptanceCriteria: ["ac:business-primary", "ac:no-unsupported-regulatory-claims"],
  permittedAuthorityLanes: ["adapt", "reject"],
  validEvidenceIds: ["evidence:business-hierarchy"],
  goldEvidenceIds: ["evidence:business-hierarchy"],
  forbiddenClaims: ["licensed in every market"],
  privateMarkers: ["/corpus/private/", "entry-private-001"],
  rubricAnchors: [
    { dimension: "product-appropriateness", score1: "Audience hierarchy is absent.", score3: "Both audiences are present but compete.", score5: "Business conversion leads and integrator access remains clear." },
    { dimension: "cross-screen-coherence", score1: "Screens share no common system.", score3: "Some shared tokens but inconsistent application.", score5: "A unified token system governs every screen." },
    { dimension: "implementation-clarity", score1: "No actionable spec for engineers.", score3: "Partial specs with ambiguity.", score5: "Engineers can build directly from the blueprint." },
    { dimension: "originality", score1: "Direct clone of an existing site.", score3: "Derivative but distinguishable.", score5: "A distinct, defensible visual system." },
    { dimension: "accessibility-and-failure-states", score1: "No accessibility or error handling.", score3: "Baseline accessibility with gaps.", score5: "WCAG-aligned with robust failure states." },
    { dimension: "evidence-discipline", score1: "Claims are unsupported.", score3: "Some claims cite evidence.", score5: "Every claim traces to validated evidence." },
  ],
  adjudicationNotes: ["Do not prescribe a brand identity or pixel layout."],
};

const productPackage = {
  schemaVersion: "1.0",
  artifactType: "c2-case-package",
  artifactId: "c2-package-stablecoin-home-v1",
  caseId: "stablecoin-home",
  caseVersion: 1,
  family: "product",
  brief: fileRef("c2-brief-stablecoin-home-v1", "corpus/c2/stablecoin-home/brief.json"),
  label: fileRef("c2-label-stablecoin-home-v1", "corpus/c2/stablecoin-home/label.json"),
  sourceSnapshot: null,
};

const migrationPackage = {
  schemaVersion: "1.0",
  artifactType: "c2-case-package",
  artifactId: "c2-package-legacy-migration-v1",
  caseId: "legacy-migration",
  caseVersion: 1,
  family: "migration",
  brief: fileRef("c2-brief-legacy-migration-v1", "corpus/c2/legacy-migration/brief.json"),
  label: fileRef("c2-label-legacy-migration-v1", "corpus/c2/legacy-migration/label.json"),
  sourceSnapshot: fileRef("snapshot-legacy-migration-v1", "corpus/c2/legacy-migration/snapshot.json"),
};

const safetyPackage = {
  schemaVersion: "1.0",
  artifactType: "c2-case-package",
  artifactId: "c2-package-empty-state-safety-v1",
  caseId: "empty-state-safety",
  caseVersion: 1,
  family: "safety",
  brief: fileRef("c2-brief-empty-state-safety-v1", "corpus/c2/empty-state-safety/brief.json"),
  label: fileRef("c2-label-empty-state-safety-v1", "corpus/c2/empty-state-safety/label.json"),
  sourceSnapshot: null,
};

describe("C2 separated case contracts", () => {
  it("accepts a separated model-visible brief and reviewer-only label", () => {
    const briefResult = C2CaseBriefSchema.safeParse(brief);
    const labelResult = C2DecisionLabelSchema.safeParse(label);
    expect(briefResult.success).toBe(true);
    expect(labelResult.success).toBe(true);
    if (briefResult.success) {
      expect(briefResult.data.caseId).toBe("stablecoin-home");
    }
    if (labelResult.success) {
      expect(labelResult.data.goldEvidenceIds).toEqual(["evidence:business-hierarchy"]);
    }
    const briefJson = JSON.stringify(brief);
    expect(briefJson).not.toContain("goldEvidenceIds");
    expect(briefJson).not.toContain("rubricAnchors");
  });

  it("rejects a label whose gold evidence is outside valid evidence", () => {
    const invalid = { ...label, goldEvidenceIds: ["evidence:unknown"] };
    const result = C2DecisionLabelSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects a migration brief without a source snapshot reference", () => {
    const invalid = { ...brief, family: "migration" };
    const result = C2CaseBriefSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate required states and blank normalized strings", () => {
    const duplicateUsers = { ...brief, users: ["operator", "operator"] };
    expect(C2CaseBriefSchema.safeParse(duplicateUsers).success).toBe(false);
    const blankTitle = { ...brief, title: "   " };
    expect(C2CaseBriefSchema.safeParse(blankTitle).success).toBe(false);
  });

  it("binds matching case and version through a strict package manifest", () => {
    const result = C2CasePackageManifestSchema.safeParse(productPackage);
    expect(result.success).toBe(true);
    const withExtra = { ...productPackage, extra: true };
    expect(C2CasePackageManifestSchema.safeParse(withExtra).success).toBe(false);
  });

  it("requires exactly one pilot package per family", () => {
    const validPilot = {
      schemaVersion: "1.0",
      artifactType: "c2-pilot-manifest",
      artifactId: "c2-pilot-v1",
      manifestVersion: 1,
      caseCount: 3,
      families: ["migration", "product", "safety"] as const,
      packages: [migrationPackage, productPackage, safetyPackage],
    };
    expect(C2PilotManifestSchema.safeParse(validPilot).success).toBe(true);

    const duplicateProductFamily = {
      ...validPilot,
      packages: [productPackage, { ...productPackage, artifactId: "c2-package-stablecoin-home-v2", caseId: "stablecoin-home-v2" }, safetyPackage],
    };
    expect(C2PilotManifestSchema.safeParse(duplicateProductFamily).success).toBe(false);
  });
});
