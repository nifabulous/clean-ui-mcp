/**
 * Unit tests for `computeRetractedApprovalIds` — the retraction validity
 * classifier introduced in Task 3.
 *
 * This is a DIRECT unit test of the exported function, not an end-to-end
 * `validateReadinessArtifacts` run: there is no in-memory validator harness
 * (the only public entry reads artifacts from disk), and building a temp
 * artifact-root fixture is out of scope for this task. Instead we construct
 * synthetic `LedgerRowT[]` rows and a synthetic `registryByVersion` map
 * structurally matching the module's internal `ParsedArtifact` shape, and
 * call `computeRetractedApprovalIds` directly.
 *
 * The registry fixture is a real on-disk registry
 * (`quality-contracts/agent-readiness/approval-actor-registry-v1.json`), not a
 * hand-rolled object, so the "valid" case is authorized by the SAME actor/role
 * data the real ledger relies on. `repo-maintainer-1` (human, Repository
 * Maintainer) is the authorized retractor; `pm-1` (human, PM only) and
 * `impl-agent-1` (agent, Engineering) are reused, unmodified, to exercise the
 * "wrong role" and "wrong actor kind" unauthorized paths — no mutation of the
 * registry data is needed for those two cases.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeRetractedApprovalIds, type ValidationIssue } from "./validator.js";
import type { CheckpointApprovalT, CheckpointRetractionT, LedgerRowT } from "./contracts.js";

const repoRoot = resolve(__dirname, "../..");
const registryV1Data = JSON.parse(
  readFileSync(
    resolve(repoRoot, "quality-contracts/agent-readiness/approval-actor-registry-v1.json"),
    "utf-8",
  ),
) as Record<string, unknown>;

// Any string works here: `entry.sha` is only ever compared for equality
// against `retractedBy.actorRegistrySha256`, never regex-validated.
const REGISTRY_SHA = "fixture-registry-sha-v1";

// Structurally matches the module-internal `ParsedArtifact` interface
// (`{ type, data, filePath, sha }`) without importing it — the interface is
// not exported, and TypeScript's structural typing accepts a same-shaped
// object literal at the `ReadonlyMap<string, ParsedArtifact>` call site.
function registryEntry(
  data: Record<string, unknown> = registryV1Data,
  sha: string = REGISTRY_SHA,
) {
  return {
    type: "approval-actor-registry",
    data,
    filePath: "approval-actor-registry-v1.json",
    sha,
  };
}

function defaultRegistryByVersion() {
  return new Map([["1.0", registryEntry()]]);
}

function makeApproval(overrides: Partial<CheckpointApprovalT> = {}): CheckpointApprovalT {
  return {
    approvalId: "a1",
    approvalKind: "checkpoint",
    checkpoint: "C0",
    decision: "approved",
    actorId: "pm-1",
    role: "PM",
    actorKind: "human",
    actorRegistryVersion: "1.0",
    actorRegistrySha256: "a".repeat(64),
    checkpointTargetSha256: "b".repeat(64),
    approvedArtifacts: [{ artifactId: "art-1", sha256: "c".repeat(64) }],
    planSha256: "d".repeat(64),
    specSha256: "e".repeat(64),
    contractHashes: {},
    decidedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// Loosely typed so invalid-fixture cases (wrong role, wrong actor kind) can be
// constructed even though the real schema locks `retractedBy.role` /
// `retractedBy.actorKind` to literals. `computeRetractedApprovalIds` reads
// these fields at runtime; the schema literals only constrain artifacts that
// go through `CheckpointRetraction.safeParse`, which this unit test bypasses.
function makeRetraction(overrides: Record<string, unknown> = {}): CheckpointRetractionT {
  const base = {
    recordKind: "retraction",
    retractionId: "r1",
    retractsApprovalId: "a1",
    retractedBy: {
      actorId: "repo-maintainer-1",
      role: "Repository Maintainer",
      actorKind: "human",
      actorRegistryVersion: "1.0",
      actorRegistrySha256: REGISTRY_SHA,
    },
    retractedAt: "2026-07-02T00:00:00.000Z",
    reason: "test retraction",
  };
  return { ...base, ...overrides } as unknown as CheckpointRetractionT;
}

function codesOf(issues: ValidationIssue[]): string[] {
  return issues.map((i) => i.code);
}

describe("retraction validity", () => {
  it("valid maintainer/human retraction clears the approval it names, no finding", () => {
    const approval = makeApproval({ approvalId: "a1" });
    const retraction = makeRetraction({ retractionId: "r1", retractsApprovalId: "a1" });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a1")).toBe(true);
    expect(issues).toEqual([]);
  });

  it("retractor whose registry role is not Repository Maintainer is unauthorized", () => {
    const approval = makeApproval({ approvalId: "a1" });
    // pm-1 is a real actor in the fixture registry with roles: ["PM"] only.
    const retraction = makeRetraction({
      retractionId: "r1",
      retractsApprovalId: "a1",
      retractedBy: {
        actorId: "pm-1",
        role: "Repository Maintainer",
        actorKind: "human",
        actorRegistryVersion: "1.0",
        actorRegistrySha256: REGISTRY_SHA,
      },
    });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-unauthorized");
  });

  it("retractor whose registry actorKind is agent is unauthorized", () => {
    const approval = makeApproval({ approvalId: "a1" });
    // impl-agent-1 is a real actor in the fixture registry, actorKind: "agent".
    const retraction = makeRetraction({
      retractionId: "r1",
      retractsApprovalId: "a1",
      retractedBy: {
        actorId: "impl-agent-1",
        role: "Repository Maintainer",
        actorKind: "human",
        actorRegistryVersion: "1.0",
        actorRegistrySha256: REGISTRY_SHA,
      },
    });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-unauthorized");
  });

  it("retractor actor absent from the pinned registry is unauthorized", () => {
    const approval = makeApproval({ approvalId: "a1" });
    const retraction = makeRetraction({
      retractionId: "r1",
      retractsApprovalId: "a1",
      retractedBy: {
        actorId: "ghost-actor-does-not-exist",
        role: "Repository Maintainer",
        actorKind: "human",
        actorRegistryVersion: "1.0",
        actorRegistrySha256: REGISTRY_SHA,
      },
    });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-unauthorized");
  });

  it("a sha256 mismatch against the pinned registry version is also unauthorized (fail-closed)", () => {
    const approval = makeApproval({ approvalId: "a1" });
    const retraction = makeRetraction({
      retractionId: "r1",
      retractsApprovalId: "a1",
      retractedBy: {
        actorId: "repo-maintainer-1",
        role: "Repository Maintainer",
        actorKind: "human",
        actorRegistryVersion: "1.0",
        actorRegistrySha256: "some-other-sha-that-does-not-match",
      },
    });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-unauthorized");
  });

  it("a schema-valid but semantically corrupt registry (validateRegistry) is also unauthorized", () => {
    // Mirrors resolveApprovalRegistry's own behavior: a registry that parses
    // fine but fails validateRegistry's semantic pass (here, declaring
    // sole-maintainer-bootstrap with no bootstrapOwnerActorId) cannot
    // authorize an approval, and by the same "one notion of a valid
    // registry" rule must not be trusted to authorize a retraction either.
    const corruptRegistryData = {
      ...registryV1Data,
      governanceMode: "sole-maintainer-bootstrap",
    };
    const approval = makeApproval({ approvalId: "a1" });
    const retraction = makeRetraction({ retractionId: "r1", retractsApprovalId: "a1" });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      new Map([["1.0", registryEntry(corruptRegistryData)]]),
      issues,
    );

    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-unauthorized");
  });

  it("retracting an approvalId that does not exist reports retraction-target-missing", () => {
    const approval = makeApproval({ approvalId: "a1" });
    const retraction = makeRetraction({
      retractionId: "r1",
      retractsApprovalId: "a-does-not-exist",
    });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a-does-not-exist")).toBe(false);
    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-target-missing");
  });

  it("retracting an approval that appears at/after the retraction is out of order", () => {
    // Retraction row precedes the approval it names in the mixed ledger.
    const retraction = makeRetraction({ retractionId: "r1", retractsApprovalId: "a1" });
    const approval = makeApproval({ approvalId: "a1" });
    const allRows: LedgerRowT[] = [retraction, approval];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("a1")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-out-of-order");
  });

  it("a retraction naming a retraction row (self-reference) is not-approval", () => {
    const approval = makeApproval({ approvalId: "a1" });
    // Self-referential: this retraction's own retractionId is its target.
    const retraction = makeRetraction({ retractionId: "self-r", retractsApprovalId: "self-r" });
    const allRows: LedgerRowT[] = [approval, retraction];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction],
      defaultRegistryByVersion(),
      issues,
    );

    expect(retracted.has("self-r")).toBe(false);
    expect(codesOf(issues)).toContain("retraction-target-not-approval");
  });

  it("two retractions naming the same approval: the second is a duplicate and inert", () => {
    const approval = makeApproval({ approvalId: "a1" });
    const retraction1 = makeRetraction({ retractionId: "r1", retractsApprovalId: "a1" });
    const retraction2 = makeRetraction({ retractionId: "r2", retractsApprovalId: "a1" });
    const allRows: LedgerRowT[] = [approval, retraction1, retraction2];
    const issues: ValidationIssue[] = [];

    const retracted = computeRetractedApprovalIds(
      allRows,
      [retraction1, retraction2],
      defaultRegistryByVersion(),
      issues,
    );

    // The first retraction is valid and clears the approval...
    expect(retracted.has("a1")).toBe(true);
    // ...and the second is reported as a duplicate rather than silently
    // accepted or double-counted.
    expect(codesOf(issues)).toContain("retraction-duplicate");
    expect(codesOf(issues).filter((c) => c === "retraction-duplicate")).toHaveLength(1);
  });
});
