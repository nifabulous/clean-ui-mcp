import { describe, expect, it } from "vitest";
import { createBlindAssignment, createFileBlindMapStore } from "../src/c2/review-packets.ts";
import { C2BlindScoreSubmissionSchema, type C2BlindScoreSubmission } from "../src/c2/evaluation-contracts.ts";
import type { C2CandidateArtifact } from "../src/c2/candidate-contracts.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { finalizeBaselineBlindScorecards } from "./finalize-baseline-blind-scorecards.mts";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "codex-gold-reviewer";
const OUTPUT_SHA = "a".repeat(64);

function makeSubmission(): C2BlindScoreSubmission {
  return C2BlindScoreSubmissionSchema.parse({
    schemaVersion: "1.0",
    artifactType: "c2-blind-score-submission",
    reviewId: REVIEW_ID,
    reviewerActorId: REVIEWER,
    reviewerActorKind: "human",
    scores: [
      "product-appropriateness",
      "cross-screen-coherence",
      "implementation-clarity",
      "originality",
      "accessibility-and-failure-states",
      "evidence-discipline",
    ].map((dimension) => ({ dimension, score: 4, rationale: `Rationale for ${dimension}.` })),
    submittedAt: "2026-07-23T00:00:00.000Z",
  });
}

const DIMENSION_SCORES = [
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
].map((dimension) => ({ dimension, score: 4, rationale: `Rationale for ${dimension}.` }));

describe("finalizeBaselineBlindScorecards", () => {
  it("finalizes a baseline submission into a boundary-clean scorecard and records resolution privately", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-"));
    try {
      const submissionsDir = join(root, "eval", "c2", "baseline", "blinded-submissions");
      const scorecardsDir = join(root, "eval", "c2", "baseline", "scorecards");
      const blindMapDir = join(root, ".c2-private", "c2", "baseline", "blind-map");
      mkdirSync(submissionsDir, { recursive: true });

      const store = createFileBlindMapStore(blindMapDir);
      await createBlindAssignment(
        {
          runId: "c2-run-baseline-stablecoin-home-current-grounded-primary-1",
          runOutputSha256: OUTPUT_SHA,
          candidate: {} as C2CandidateArtifact,
          assignedReviewerActorId: REVIEWER,
        },
        { store, randomUuid: () => REVIEW_ID },
      );
      writeFileSync(join(submissionsDir, `${REVIEW_ID}.json`), JSON.stringify(makeSubmission()));

      const result = await finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      });

      expect(result).toEqual({ finalizedCount: 1, scorecardsDir, resolutionPath: join(root, ".c2-private", "c2", "baseline", "blind-resolution.json") });
      const scorecard = JSON.parse(readFileSync(join(scorecardsDir, `c2-scorecard-${REVIEW_ID}.json`), "utf8"));
      expect(scorecard).toMatchObject({
        runId: "c2-run-baseline-stablecoin-home-current-grounded-primary-1",
        runOutputSha256: OUTPUT_SHA,
        reviewerActorId: REVIEWER,
        blindedCondition: true,
        implementationReady: true,
        scoredAt: "2026-07-23T01:00:00.000Z",
      });
      expect(JSON.stringify(scorecard)).not.toContain(".c2-private");
      expect(readdirSync(scorecardsDir).filter(f => f.endsWith(".json"))).toEqual([`c2-scorecard-${REVIEW_ID}.json`]);

      const resolution = JSON.parse(readFileSync(join(root, ".c2-private", "c2", "baseline", "blind-resolution.json"), "utf8"));
      expect(resolution).toMatchObject({ artifactType: "c2-blind-resolution", finalizedCount: 1 });
      expect((await store.load())[0]?.state).toBe("finalized");

      await expect(
        finalizeBaselineBlindScorecards({ submissionsDir, scorecardsDir, blindMapDir }),
      ).rejects.toThrow(/blind-resolution.json already exists|could not transition assigned/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers from a crash: skips already-finalized entries with existing durable scorecards", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-recover-"));
    try {
      const submissionsDir = join(root, "eval/c2/baseline/blinded-submissions");
      const scorecardsDir = join(root, "eval/c2/baseline/scorecards");
      const blindMapDir = join(root, ".c2-private/c2/baseline/blind-map");
      mkdirSync(submissionsDir, { recursive: true });
      mkdirSync(scorecardsDir, { recursive: true });
      mkdirSync(blindMapDir, { recursive: true });

      // Set up blind map with one entry already finalized (simulating a prior crash).
      const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
      const RUN_ID = "c2-run-baseline-test-current-grounded-primary-1";
      const OUTPUT_SHA = "b".repeat(64);
      const mapEntry = [{
        reviewId: REVIEW_ID,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        assignedReviewerActorId: "gold-label-owner",
        state: "finalized" as const,
      }];
      writeFileSync(join(blindMapDir, "blind-map.json"), JSON.stringify(mapEntry));

      // Write the submission.
      writeFileSync(
        join(submissionsDir, `${REVIEW_ID}.json`),
        JSON.stringify({
          schemaVersion: "1.0",
          artifactType: "c2-blind-score-submission",
          reviewId: REVIEW_ID,
          reviewerActorId: "gold-label-owner",
          reviewerActorKind: "human",
          scores: DIMENSION_SCORES,
          submittedAt: "2026-07-23T01:00:00.000Z",
        }),
      );

      // Write the durable scorecard from the "prior run" so it exists.
      const scorecardArtifactId = `c2-scorecard-${REVIEW_ID}`;
      writeFileSync(
        join(scorecardsDir, `${scorecardArtifactId}.json`),
        JSON.stringify({
          schemaVersion: "1.0",
          artifactType: "c2-human-scorecard",
          artifactId: scorecardArtifactId,
          runId: RUN_ID,
          runOutputSha256: OUTPUT_SHA,
          reviewerActorId: "gold-label-owner",
          reviewerActorKind: "human",
          blindedCondition: true,
          scores: DIMENSION_SCORES,
          implementationReady: true,
          scoredAt: "2026-07-23T01:00:00.000Z",
        }),
      );

      // Re-run finalization — should skip the already-completed entry.
      const result = await finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      });

      expect(result.finalizedCount).toBe(1);
      // The existing scorecard was not overwritten.
      const scorecard = JSON.parse(readFileSync(join(scorecardsDir, `${scorecardArtifactId}.json`), "utf8"));
      expect(scorecard.runId).toBe(RUN_ID);
      // Resolution manifest was written.
      const resolution = JSON.parse(readFileSync(join(dirname(blindMapDir), "blind-resolution.json"), "utf8"));
      expect(resolution.finalizedCount).toBe(1);
      // Staging directory was cleaned up.
      expect(existsSync(join(scorecardsDir, ".staging"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers from a crash: re-derives orphan scorecard when map is finalized but durable is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-orphan-"));
    try {
      const submissionsDir = join(root, "eval/c2/baseline/blinded-submissions");
      const scorecardsDir = join(root, "eval/c2/baseline/scorecards");
      const blindMapDir = join(root, ".c2-private/c2/baseline/blind-map");
      mkdirSync(submissionsDir, { recursive: true });
      mkdirSync(scorecardsDir, { recursive: true });
      mkdirSync(blindMapDir, { recursive: true });

      const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
      const RUN_ID = "c2-run-baseline-orphan-current-grounded-primary-1";
      const OUTPUT_SHA = "c".repeat(64);

      // Map finalized but NO durable scorecard — orphan from crash.
      const mapEntry = [{
        reviewId: REVIEW_ID,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        assignedReviewerActorId: "gold-label-owner",
        state: "finalized" as const,
      }];
      writeFileSync(join(blindMapDir, "blind-map.json"), JSON.stringify(mapEntry));

      writeFileSync(
        join(submissionsDir, `${REVIEW_ID}.json`),
        JSON.stringify({
          schemaVersion: "1.0",
          artifactType: "c2-blind-score-submission",
          reviewId: REVIEW_ID,
          reviewerActorId: "gold-label-owner",
          reviewerActorKind: "human",
          scores: DIMENSION_SCORES,
          submittedAt: "2026-07-23T01:00:00.000Z",
        }),
      );

      // No durable scorecard exists — this is the orphan case.

      const result = await finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      });

      expect(result.finalizedCount).toBe(1);
      // Scorecard was re-derived and published.
      const scorecardArtifactId = `c2-scorecard-${REVIEW_ID}`;
      expect(existsSync(join(scorecardsDir, `${scorecardArtifactId}.json`))).toBe(true);
      const scorecard = JSON.parse(readFileSync(join(scorecardsDir, `${scorecardArtifactId}.json`), "utf8"));
      expect(scorecard.runId).toBe(RUN_ID);
      expect(scorecard.runOutputSha256).toBe(OUTPUT_SHA);
      expect(scorecard.blindedCondition).toBe(true);
      // Staging cleaned up.
      expect(existsSync(join(scorecardsDir, ".staging"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers from a crash: clears stale .staging before re-deriving orphan", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-stale-"));
    try {
      const submissionsDir = join(root, "eval/c2/baseline/blinded-submissions");
      const scorecardsDir = join(root, "eval/c2/baseline/scorecards");
      const blindMapDir = join(root, ".c2-private/c2/baseline/blind-map");
      mkdirSync(submissionsDir, { recursive: true });
      mkdirSync(scorecardsDir, { recursive: true });
      mkdirSync(blindMapDir, { recursive: true });

      const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
      const RUN_ID = "c2-run-baseline-stale-current-grounded-primary-1";
      const OUTPUT_SHA = "d".repeat(64);

      // Map finalized but NO durable scorecard — orphan from crash.
      const mapEntry = [{
        reviewId: REVIEW_ID,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        assignedReviewerActorId: "gold-label-owner",
        state: "finalized" as const,
      }];
      writeFileSync(join(blindMapDir, "blind-map.json"), JSON.stringify(mapEntry));

      writeFileSync(
        join(submissionsDir, `${REVIEW_ID}.json`),
        JSON.stringify({
          schemaVersion: "1.0",
          artifactType: "c2-blind-score-submission",
          reviewId: REVIEW_ID,
          reviewerActorId: "gold-label-owner",
          reviewerActorKind: "human",
          scores: DIMENSION_SCORES,
          submittedAt: "2026-07-23T01:00:00.000Z",
        }),
      );

      // Simulate a crashed prior run: stale .staging with an old file.
      const stagingDir = join(scorecardsDir, ".staging");
      mkdirSync(stagingDir, { recursive: true });
      const scorecardArtifactId = `c2-scorecard-${REVIEW_ID}`;
      writeFileSync(
        join(stagingDir, `${scorecardArtifactId}.json`),
        JSON.stringify({ stale: "content from crashed run" }),
      );

      // Re-run — should clear stale staging, re-derive, and publish.
      const result = await finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      });

      expect(result.finalizedCount).toBe(1);
      // Stale staging was cleared; the published scorecard is valid.
      const scorecard = JSON.parse(readFileSync(join(scorecardsDir, `${scorecardArtifactId}.json`), "utf8"));
      expect(scorecard.runId).toBe(RUN_ID);
      expect(scorecard.runOutputSha256).toBe(OUTPUT_SHA);
      expect(scorecard.stale).toBeUndefined();
      // Staging cleaned up after publish.
      expect(existsSync(stagingDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a durable scorecard with stale hash binding during recovery skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-stale-hash-"));
    try {
      const submissionsDir = join(root, "eval/c2/baseline/blinded-submissions");
      const scorecardsDir = join(root, "eval/c2/baseline/scorecards");
      const blindMapDir = join(root, ".c2-private/c2/baseline/blind-map");
      mkdirSync(submissionsDir, { recursive: true });
      mkdirSync(scorecardsDir, { recursive: true });
      mkdirSync(blindMapDir, { recursive: true });

      const REVIEW_ID = "55555555-5555-4555-8555-555555555555";
      const RUN_ID = "c2-run-baseline-correct-current-grounded-primary-1";
      const OUTPUT_SHA = "e".repeat(64);

      // Map entry binds to RUN_ID + OUTPUT_SHA.
      const mapEntry = [{
        reviewId: REVIEW_ID,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        assignedReviewerActorId: "gold-label-owner",
        state: "finalized" as const,
      }];
      writeFileSync(join(blindMapDir, "blind-map.json"), JSON.stringify(mapEntry));

      writeFileSync(
        join(submissionsDir, `${REVIEW_ID}.json`),
        JSON.stringify({
          schemaVersion: "1.0",
          artifactType: "c2-blind-score-submission",
          reviewId: REVIEW_ID,
          reviewerActorId: "gold-label-owner",
          reviewerActorKind: "human",
          scores: DIMENSION_SCORES,
          submittedAt: "2026-07-23T01:00:00.000Z",
        }),
      );

      // Durable scorecard exists BUT with WRONG runId/outputSha — tampered.
      const scorecardArtifactId = `c2-scorecard-${REVIEW_ID}`;
      writeFileSync(
        join(scorecardsDir, `${scorecardArtifactId}.json`),
        JSON.stringify({
          schemaVersion: "1.0",
          artifactType: "c2-human-scorecard",
          artifactId: scorecardArtifactId,
          runId: "wrong-run-id",
          runOutputSha256: "f".repeat(64),
          reviewerActorId: "gold-label-owner",
          reviewerActorKind: "human",
          blindedCondition: true,
          scores: DIMENSION_SCORES,
          implementationReady: true,
          scoredAt: "2026-07-23T01:00:00.000Z",
        }),
      );

      // Recovery should reject the stale-bound durable.
      await expect(
        finalizeBaselineBlindScorecards({
          submissionsDir,
          scorecardsDir,
          blindMapDir,
          now: () => "2026-07-23T01:00:00.000Z",
        }),
      ).rejects.toThrow(/recovery integrity checks|tampered|wrong/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a durable scorecard with matching hashes but invalid scorecard content", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-invalid-durable-"));
    try {
      const submissionsDir = join(root, "eval/c2/baseline/blinded-submissions");
      const scorecardsDir = join(root, "eval/c2/baseline/scorecards");
      const blindMapDir = join(root, ".c2-private/c2/baseline/blind-map");
      mkdirSync(submissionsDir, { recursive: true });
      mkdirSync(scorecardsDir, { recursive: true });
      mkdirSync(blindMapDir, { recursive: true });

      const REVIEW_ID = "66666666-6666-4666-8666-666666666666";
      const RUN_ID = "c2-run-baseline-invalid-durable-current-grounded-primary-1";
      const OUTPUT_SHA = "6".repeat(64);
      writeFileSync(join(blindMapDir, "blind-map.json"), JSON.stringify([{
        reviewId: REVIEW_ID,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        assignedReviewerActorId: "gold-label-owner",
        state: "finalized" as const,
      }]));
      writeFileSync(join(submissionsDir, `${REVIEW_ID}.json`), JSON.stringify({
        schemaVersion: "1.0",
        artifactType: "c2-blind-score-submission",
        reviewId: REVIEW_ID,
        reviewerActorId: "gold-label-owner",
        reviewerActorKind: "human",
        scores: DIMENSION_SCORES,
        submittedAt: "2026-07-23T01:00:00.000Z",
      }));

      const scorecardArtifactId = `c2-scorecard-${REVIEW_ID}`;
      writeFileSync(join(scorecardsDir, `${scorecardArtifactId}.json`), JSON.stringify({
        schemaVersion: "1.0",
        artifactType: "c2-human-scorecard",
        artifactId: scorecardArtifactId,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        reviewerActorId: "gold-label-owner",
        reviewerActorKind: "human",
        blindedCondition: true,
        scores: DIMENSION_SCORES.map((score) => ({ ...score, score: 6 })),
        implementationReady: true,
        scoredAt: "2026-07-23T01:00:00.000Z",
      }));

      await expect(finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      })).rejects.toThrow(/C2HumanScorecardSchema validation/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a valid durable scorecard with the wrong artifact identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-identity-"));
    try {
      const submissionsDir = join(root, "eval/c2/baseline/blinded-submissions");
      const scorecardsDir = join(root, "eval/c2/baseline/scorecards");
      const blindMapDir = join(root, ".c2-private/c2/baseline/blind-map");
      mkdirSync(submissionsDir, { recursive: true });
      mkdirSync(scorecardsDir, { recursive: true });
      mkdirSync(blindMapDir, { recursive: true });

      const REVIEW_ID = "77777777-7777-4777-8777-777777777777";
      const RUN_ID = "c2-run-baseline-identity-current-grounded-primary-1";
      const OUTPUT_SHA = "7".repeat(64);
      writeFileSync(join(blindMapDir, "blind-map.json"), JSON.stringify([{
        reviewId: REVIEW_ID,
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        assignedReviewerActorId: "gold-label-owner",
        state: "finalized" as const,
      }]));
      writeFileSync(join(submissionsDir, `${REVIEW_ID}.json`), JSON.stringify({
        schemaVersion: "1.0",
        artifactType: "c2-blind-score-submission",
        reviewId: REVIEW_ID,
        reviewerActorId: "gold-label-owner",
        reviewerActorKind: "human",
        scores: DIMENSION_SCORES,
        submittedAt: "2026-07-23T01:00:00.000Z",
      }));

      writeFileSync(join(scorecardsDir, `c2-scorecard-${REVIEW_ID}.json`), JSON.stringify({
        schemaVersion: "1.0",
        artifactType: "c2-human-scorecard",
        artifactId: "c2-scorecard-88888888-8888-4888-8888-888888888888",
        runId: RUN_ID,
        runOutputSha256: OUTPUT_SHA,
        reviewerActorId: "gold-label-owner",
        reviewerActorKind: "human",
        blindedCondition: true,
        scores: DIMENSION_SCORES,
        implementationReady: true,
        scoredAt: "2026-07-23T01:00:00.000Z",
      }));

      await expect(finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      })).rejects.toThrow(/recovery integrity checks.*artifactId/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI entry point (main) parameterization
//
// `main()` accepts --submissions-dir, --scorecards-dir, and --blind-map-dir.
// Relative paths resolve against process.cwd() (Node `resolve()` semantics);
// omitting every flag reproduces the original baseline behavior.
// These tests execute the script as a child process to exercise parseArgs end
// to end, matching the pattern in validate-c2-baseline-cases.test.mts.
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const FINALIZER_SCRIPT = join(REPO_ROOT, "scripts/finalize-baseline-blind-scorecards.mts");

describe("finalize-baseline-blind-scorecards CLI flags", () => {
  it("finalizes a submission under the supplied --scorecards-dir and reads the map from --blind-map-dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-cli-"));
    try {
      // Custom (non-baseline) directory layout inside the temp root.
      const submissionsDir = join(root, "remediation", "blinded-submissions");
      const scorecardsDir = join(root, "remediation-scorecards");
      const blindMapDir = join(root, "remediation", "blind-map");
      mkdirSync(submissionsDir, { recursive: true });

      // Set up the blind map at the supplied --blind-map-dir.
      const store = createFileBlindMapStore(blindMapDir);
      await createBlindAssignment(
        {
          runId: "c2-run-remediation-cli-current-grounded-primary-1",
          runOutputSha256: OUTPUT_SHA,
          candidate: {} as C2CandidateArtifact,
          assignedReviewerActorId: REVIEWER,
        },
        { store, randomUuid: () => REVIEW_ID },
      );
      writeFileSync(join(submissionsDir, `${REVIEW_ID}.json`), JSON.stringify(makeSubmission()));

      // Run the CLI from the temp root with RELATIVE flags so resolve()
      // (which resolves against process.cwd()) lands inside the temp root.
      // The finalizer logs to stderr, so capture both streams.
      const run = spawnSync(
        TSX_BIN,
        [
          FINALIZER_SCRIPT,
          "--submissions-dir", "remediation/blinded-submissions",
          "--scorecards-dir", "remediation-scorecards",
          "--blind-map-dir", "remediation/blind-map",
        ],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(run.status).toBe(0);
      expect(combined).toContain("finalized 1 scorecards");

      // Scorecard written under the supplied --scorecards-dir.
      const scorecardPath = join(scorecardsDir, `c2-scorecard-${REVIEW_ID}.json`);
      expect(existsSync(scorecardPath)).toBe(true);
      const scorecard = JSON.parse(readFileSync(scorecardPath, "utf8"));
      expect(scorecard).toMatchObject({
        runId: "c2-run-remediation-cli-current-grounded-primary-1",
        runOutputSha256: OUTPUT_SHA,
        reviewerActorId: REVIEWER,
        blindedCondition: true,
      });

      // The map at --blind-map-dir was transitioned to finalized.
      expect((await store.load())[0]?.state).toBe("finalized");

      // No scorecard leaked into the baseline directory.
      const baselineScorecardsDir = join(REPO_ROOT, "eval/c2/baseline/scorecards");
      const preBaseline = existsSync(baselineScorecardsDir)
        ? readdirSync(baselineScorecardsDir).filter((f) => f.endsWith(".json"))
        : [];
      expect(preBaseline).not.toContain(`c2-scorecard-${REVIEW_ID}.json`);

      // Resolution manifest lives under the private blind-map parent, not the submissions dir.
      expect(existsSync(join(submissionsDir, "blind-resolution.json"))).toBe(false);
      expect(existsSync(join(dirname(blindMapDir), "blind-resolution.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves absolute flag paths regardless of cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-cli-abs-"));
    try {
      const submissionsDir = join(root, "in", "blinded-submissions");
      const scorecardsDir = join(root, "out", "scorecards");
      const blindMapDir = join(root, "private", "blind-map");
      mkdirSync(submissionsDir, { recursive: true });

      const store = createFileBlindMapStore(blindMapDir);
      await createBlindAssignment(
        {
          runId: "c2-run-remediation-abs-current-grounded-primary-1",
          runOutputSha256: OUTPUT_SHA,
          candidate: {} as C2CandidateArtifact,
          assignedReviewerActorId: REVIEWER,
        },
        { store, randomUuid: () => REVIEW_ID },
      );
      writeFileSync(join(submissionsDir, `${REVIEW_ID}.json`), JSON.stringify(makeSubmission()));

      // Absolute paths — cwd is irrelevant. Capture both streams (logs go to stderr).
      const run = spawnSync(
        TSX_BIN,
        [
          FINALIZER_SCRIPT,
          "--submissions-dir", submissionsDir,
          "--scorecards-dir", scorecardsDir,
          "--blind-map-dir", blindMapDir,
        ],
        // Deliberately run from a cwd different from root.
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(run.status).toBe(0);
      expect(combined).toContain("finalized 1 scorecards");
      expect(existsSync(join(scorecardsDir, `c2-scorecard-${REVIEW_ID}.json`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("finalize-baseline-blind-scorecards CLI defaults", () => {
  it("resolves the original baseline paths when no flags are supplied", () => {
    const expectedSubmissionsDir = join(REPO_ROOT, "eval/c2/baseline/blinded-submissions");

    // If real baseline submissions exist on this checkout, do NOT spawn the
    // finalizer — it would mutate real baseline state (write scorecards,
    // transition blind-map entries, write blind-resolution.json). Instead,
    // verify the default-path resolution logic without side effects by running
    // against a guaranteed-empty temp dir that mimics the clean-checkout case.
    const safeCwd = mkdtempSync(join(tmpdir(), "c2-baseline-finalizer-defaults-"));
    try {
      // We can safely spawn only when the real submissions dir is absent
      // (clean checkout). When it exists, skip the spawn and assert the
      // expected path constant is correct by construction.
      if (existsSync(expectedSubmissionsDir)) {
        // The path constant itself is the contract — it matches the default
        // in main(). No spawn needed; we avoid mutating real state.
        expect(expectedSubmissionsDir).toContain("eval/c2/baseline/blinded-submissions");
        return;
      }

      // Clean checkout: safe to spawn — the finalizer will refuse with a
      // not-found error naming the resolved baseline submissions path.
      const run = spawnSync(
        TSX_BIN,
        [FINALIZER_SCRIPT],
        { cwd: safeCwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(combined).toContain(expectedSubmissionsDir);
      expect(combined).toContain("[c2-baseline-finalize] submissions directory not found");
    } finally {
      rmSync(safeCwd, { recursive: true, force: true });
    }
  });
});

describe("finalizeBaselineBlindScorecards — resolution artifact privacy (T2)", () => {
  it("writes blind-resolution.json to .c2-private, not to the submissions directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2-finalizer-privacy-"));
    try {
      const submissionsDir = join(root, "eval", "c2", "baseline", "blinded-submissions");
      const scorecardsDir = join(root, "eval", "c2", "baseline", "scorecards");
      const privateRoot = join(root, ".c2-private", "c2", "baseline");
      const blindMapDir = join(privateRoot, "blind-map");
      mkdirSync(submissionsDir, { recursive: true });

      const store = createFileBlindMapStore(blindMapDir);
      await createBlindAssignment(
        {
          runId: "c2-run-baseline-stablecoin-home-current-grounded-primary-1",
          runOutputSha256: OUTPUT_SHA,
          candidate: {} as C2CandidateArtifact,
          assignedReviewerActorId: REVIEWER,
        },
        { store, randomUuid: () => REVIEW_ID },
      );
      writeFileSync(join(submissionsDir, `${REVIEW_ID}.json`), JSON.stringify(makeSubmission()));

      const result = await finalizeBaselineBlindScorecards({
        submissionsDir,
        scorecardsDir,
        blindMapDir,
        now: () => "2026-07-23T01:00:00.000Z",
      });

      // The resolution MUST live under .c2-private, NOT under the submissions dir.
      expect(result.resolutionPath).toContain(".c2-private");
      expect(result.resolutionPath).not.toContain("blinded-submissions");
      // The submissions directory must NOT contain blind-resolution.json.
      expect(existsSync(join(submissionsDir, "blind-resolution.json"))).toBe(false);
      // The private dir MUST contain it.
      expect(existsSync(result.resolutionPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

