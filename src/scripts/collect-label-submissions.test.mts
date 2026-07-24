/**
 * Tests for the collect-label-submissions workflow helper.
 *
 * The helper collects + validates the two C2 independent label submissions
 * (Gold Label Owner + QA) and refuses to synthesize a missing one. The
 * load-bearing guard tested here is the distinct-actor / distinct-role
 * cross-check, which `--sole-operator-review` must relax for the actor
 * (same human performs both passes) WITHOUT relaxing the role requirement.
 *
 * Two test strata:
 *
 *   - IN-PROCESS unit tests against the pure `computeActorRoleErrors`
 *     helper. These pin the three required scenarios directly:
 *       1. same-actor WITHOUT the flag  -> error (existing behaviour)
 *       2. same-actor WITH the flag     -> no error (roles still distinct)
 *       3. same-role WITH the flag      -> error (role check always fires)
 *
 *   - SUBPROCESS tests that spawn the script via `tsx` against real fixture
 *     files in a temp dir, proving the flag is wired through parseArgs and
 *     the full validation pipeline (parseArgs -> schema -> selection match
 *     -> actor/role guard -> READY). These mirror the run-c2-baseline CLI
 *     test pattern.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeActorRoleErrors } from "./collect-label-submissions.mts";

// ---------------------------------------------------------------------------
// Pure-logic tests (no I/O).
// ---------------------------------------------------------------------------

describe("computeActorRoleErrors (sole-operator-review guard)", () => {
  const gold = { actorId: "operator-1", reviewerRole: "Gold Label Owner" };
  const qa = { actorId: "operator-2", reviewerRole: "QA" };

  it("distinct actors + distinct roles: no errors, with or without the flag", () => {
    expect(computeActorRoleErrors(gold, qa, false)).toEqual([]);
    expect(computeActorRoleErrors(gold, qa, true)).toEqual([]);
  });

  it("same-actor WITHOUT the flag still fails (existing behaviour)", () => {
    const sameActorQa = { actorId: "operator-1", reviewerRole: "QA" };
    const errors = computeActorRoleErrors(gold, sameActorQa, false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/distinct actors/i);
    expect(errors[0]).toContain("operator-1");
  });

  it("same-actor WITH the flag succeeds (roles still distinct/correct)", () => {
    const sameActorQa = { actorId: "operator-1", reviewerRole: "QA" };
    const errors = computeActorRoleErrors(gold, sameActorQa, true);
    expect(errors).toEqual([]);
  });

  it("same-role still fails even WITH the flag (role check always fires)", () => {
    // Both carry the Gold Label Owner role -> role check fires regardless of flag.
    const sameRoleQa = { actorId: "operator-2", reviewerRole: "Gold Label Owner" };
    const errors = computeActorRoleErrors(gold, sameRoleQa, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/distinct reviewer roles/i);

    // And without the flag too.
    expect(computeActorRoleErrors(gold, sameRoleQa, false)).toHaveLength(1);
  });

  it("same-actor AND same-role WITH the flag reports only the role error", () => {
    // Flag relaxes the actor check; the role check is the only remaining error.
    const sameBoth = { actorId: "operator-1", reviewerRole: "Gold Label Owner" };
    const errors = computeActorRoleErrors(gold, sameBoth, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/distinct reviewer roles/i);
  });
});

// ---------------------------------------------------------------------------
// Subprocess (end-to-end) tests.
//
// Builds a minimal-but-valid 40-entry selection + two submissions in a temp
// dir, then runs the script via `tsx`. This proves:
//   - parseArgs accepts --sole-operator-review
//   - the same-actor block is skipped under the flag
//   - the READY message tags sole-operator mode
//   - the same-role check still fires under the flag
// ---------------------------------------------------------------------------

/** A canonical 64-hex sha256 placeholder. */
const SHA = "0".repeat(64);
const GIT_SHA = "1".repeat(40);

interface EntrySeed {
  entryId: string;
  cohort: "reproducible" | "challenge";
  stratum: string;
}

/** Build 40 entries (35 reproducible + 5 challenge) to satisfy the selection schema. */
function buildEntries(): EntrySeed[] {
  const entries: EntrySeed[] = [];
  for (let i = 0; i < 35; i += 1) {
    entries.push({
      entryId: `entry-repro-${i}`,
      cohort: "reproducible",
      stratum: `stratum-${i % 3}`,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    entries.push({
      entryId: `entry-chal-${i}`,
      cohort: "challenge",
      stratum: `stratum-chal-${i % 2}`,
    });
  }
  return entries;
}

function buildSelection() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-label-integrity-selection",
    artifactId: "c2-selection-test-v1",
    selectionVersion: 1,
    seed: "clean-ui-retag-v1",
    corpusGitSha: GIT_SHA,
    corpusSha256: SHA,
    entries: buildEntries().map((e) => ({
      entryId: e.entryId,
      cohort: e.cohort,
      stratum: e.stratum,
      selectionReason: `reason for ${e.entryId}`,
      imageSha256: SHA,
    })),
  };
}

function buildSubmission(opts: {
  role: "Gold Label Owner" | "QA";
  actorId: string;
  selectionArtifactId: string;
}) {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-independent-label-submission",
    artifactId: `c2-submission-${opts.role.toLowerCase().replace(/\s+/g, "-")}-v1`,
    selectionArtifactId: opts.selectionArtifactId,
    selectionSha256: SHA,
    submissionVersion: 1,
    actorId: opts.actorId,
    actorKind: "human",
    reviewerRole: opts.role,
    sealedAt: "2026-07-22T00:00:00.000Z",
    labels: buildEntries().map((e) => ({
      entryId: e.entryId,
      patternType: "pattern-a",
      categories: ["cat-a"],
      components: ["comp-a"],
      domainTags: ["tag-a"],
      visualFields: { field1: "value" },
      groundedClaimIds: ["claim-a"],
      accessibilityEvidenceIds: [],
      critiqueQuality: "acceptable",
      protectedFieldExpectation: "unchanged",
    })),
  };
}

interface Fixture {
  gold: { role: "Gold Label Owner"; actorId: string };
  qa: { role: "QA" | "Gold Label Owner"; actorId: string };
  soleOperator: boolean;
}

function runCollector(fixture: Fixture): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "collect-label-"));
  try {
    const selection = buildSelection();
    writeFileSync(join(dir, "selection.json"), JSON.stringify(selection));
    const gold = buildSubmission({
      ...fixture.gold,
      selectionArtifactId: selection.artifactId,
    });
    const qa = buildSubmission({
      ...fixture.qa,
      selectionArtifactId: selection.artifactId,
    });
    writeFileSync(join(dir, "gold.json"), JSON.stringify(gold));
    writeFileSync(join(dir, "qa.json"), JSON.stringify(qa));

    const args = [
      "--selection",
      join(dir, "selection.json"),
      "--gold",
      join(dir, "gold.json"),
      "--qa",
      join(dir, "qa.json"),
    ];
    if (fixture.soleOperator) args.push("--sole-operator-review");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("src/scripts/collect-label-submissions.mts"), ...args],
      { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe" },
    );
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("collect-label-submissions CLI (--sole-operator-review)", () => {
  it("rejects same-actor submissions WITHOUT the flag (exit 1)", () => {
    const res = runCollector({
      gold: { role: "Gold Label Owner", actorId: "operator-1" },
      qa: { role: "QA", actorId: "operator-1" },
      soleOperator: false,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/distinct actors/i);
  });

  it("accepts same-actor submissions WITH the flag (exit 0, READY tags mode)", () => {
    const res = runCollector({
      gold: { role: "Gold Label Owner", actorId: "operator-1" },
      qa: { role: "QA", actorId: "operator-1" },
      soleOperator: true,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/READY \[SOLE-OPERATOR REVIEW\]/);
  });

  it("rejects same-role submissions even WITH the flag (exit 1)", () => {
    const res = runCollector({
      gold: { role: "Gold Label Owner", actorId: "operator-1" },
      qa: { role: "Gold Label Owner", actorId: "operator-2" },
      soleOperator: true,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/distinct reviewer roles/i);
  });

  it("accepts distinct-actor/distinct-role submissions WITHOUT the flag (exit 0)", () => {
    const res = runCollector({
      gold: { role: "Gold Label Owner", actorId: "operator-1" },
      qa: { role: "QA", actorId: "operator-2" },
      soleOperator: false,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/READY —/);
    expect(res.stdout).not.toMatch(/SOLE-OPERATOR/);
  });
});
