import { describe, expect, it } from "vitest";
import { createBlindAssignment, createFileBlindMapStore } from "../src/c2/review-packets.ts";
import { C2BlindScoreSubmissionSchema, type C2BlindScoreSubmission } from "../src/c2/evaluation-contracts.ts";
import type { C2CandidateArtifact } from "../src/c2/candidate-contracts.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

      expect(result).toEqual({ finalizedCount: 1, scorecardsDir, resolutionPath: join(submissionsDir, "blind-resolution.json") });
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

      const resolution = JSON.parse(readFileSync(join(submissionsDir, "blind-resolution.json"), "utf8"));
      expect(resolution).toMatchObject({ artifactType: "c2-baseline-blind-resolution", finalizedCount: 1 });
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
      const resolution = JSON.parse(readFileSync(join(submissionsDir, "blind-resolution.json"), "utf8"));
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
});
