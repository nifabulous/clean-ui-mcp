import { describe, expect, it } from "vitest";
import {
  C2_REQUIRED_APPROVAL_ROLES,
  C2ProvisionalEvidenceManifestSchema,
} from "./governance-contracts.js";

const SHA_64 = "a".repeat(64);
const SHA_40 = "b".repeat(40);

function fileRef(artifactId: string, path: string, sha256: string = SHA_64) {
  return { artifactId, path, sha256 };
}

function pilotManifestRef() {
  return {
    ...fileRef("c2-pilot-manifest-v1", "corpus/c2/pilot/manifest.json"),
    artifactType: "c2-pilot-manifest" as const,
  };
}

function makeManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-provisional-evidence-manifest" as const,
    artifactId: "c2-provisional-evidence-v1",
    manifestVersion: 1,
    state: "provisional" as const,
    sourceGitSha: SHA_40,
    specSha256: SHA_64,
    planSha256: SHA_64,
    corpusSha256: null,
    retrievalIndexSha256: null,
    requiredApprovalRoles: ["Gold Label Owner", "QA"] as const,
    pilotManifest: pilotManifestRef(),
    rationale: "C2 evidence is collected provisionally while the gold-readiness case is open.",
    ...overrides,
  };
}

describe("C2 provisional governance contracts", () => {
  it("declares exact C2 closure roles without creating approvals", () => {
    expect(C2_REQUIRED_APPROVAL_ROLES).toEqual(["Gold Label Owner", "QA"]);

    const manifest = C2ProvisionalEvidenceManifestSchema.parse(makeManifest());
    expect(manifest.state).toBe("provisional");
    expect(manifest.requiredApprovalRoles).toEqual(["Gold Label Owner", "QA"]);
  });

  it("rejects an unexpected evidence artifact type", () => {
    expect(C2ProvisionalEvidenceManifestSchema.safeParse(makeManifest()).success).toBe(true);

    // Wrong artifactType on the manifest itself.
    expect(
      C2ProvisionalEvidenceManifestSchema.safeParse(
        makeManifest({ artifactType: "c2-frozen-evidence-manifest" }),
      ).success,
    ).toBe(false);

    // Pilot manifest ref with the wrong artifactType fails. The reference must
    // point at a c2-pilot-manifest; a different artifact type is rejected.
    const wrongPilot = makeManifest({
      pilotManifest: {
        ...pilotManifestRef(),
        artifactType: "c2-case-package",
      },
    });
    expect(C2ProvisionalEvidenceManifestSchema.safeParse(wrongPilot).success).toBe(false);
  });

  it("cannot be relabelled as frozen or approved", () => {
    // Relabelling the state to "frozen" fails.
    expect(
      C2ProvisionalEvidenceManifestSchema.safeParse(
        makeManifest({ state: "frozen" as unknown as "provisional" }),
      ).success,
    ).toBe(false);

    // Adding an approvals field fails: the schema is strict and has no approvals
    // field, so provisional evidence can never carry approval records.
    const withApprovals = makeManifest({ approvals: [] });
    expect(C2ProvisionalEvidenceManifestSchema.safeParse(withApprovals).success).toBe(false);

    // A populated corpusSha256 is also forbidden while provisional.
    const frozenCorpus = makeManifest({ corpusSha256: SHA_64 });
    expect(C2ProvisionalEvidenceManifestSchema.safeParse(frozenCorpus).success).toBe(false);
  });
});
