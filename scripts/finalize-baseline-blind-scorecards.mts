#!/usr/bin/env node
/**
 * Finalize baseline blind-score submissions into durable scorecards.
 *
 * Reviewer submissions stay under eval/c2/baseline/blinded-submissions during
 * the review window. The private baseline blind map is resolved only here;
 * the resulting scorecards contain the run/output binding but no private
 * response or condition payload. The reviewId-to-run resolution manifest
 * remains private beside the submissions.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createFileBlindMapStore,
  finalizeBlindScorecard,
} from "../src/c2/review-packets.ts";
import { C2HumanScorecardSchema, C2BlindScoreSubmissionSchema, type C2BlindScoreSubmission } from "../src/c2/evaluation-contracts.ts";
import {
  writeDurableArtifact,
  writePrivateArtifact,
} from "../src/c2/private-artifacts.ts";
import { canonicalJsonStringify } from "../src/readiness/contracts.ts";

export interface FinalizeBaselineBlindScorecardsInput {
  submissionsDir: string;
  scorecardsDir: string;
  blindMapDir: string;
  now?: () => string;
}

export interface FinalizeBaselineBlindScorecardsResult {
  finalizedCount: number;
  scorecardsDir: string;
  resolutionPath: string;
}

function durableBoundaryScan() {
  const secretEnvNames = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  return {
    secretValues: secretEnvNames
      .map((name) => process.env[name] ?? "")
      .filter((value) => value.length > 0),
    secretEnvNames,
  };
}

export async function finalizeBaselineBlindScorecards(
  input: FinalizeBaselineBlindScorecardsInput,
): Promise<FinalizeBaselineBlindScorecardsResult> {
  if (!existsSync(input.submissionsDir)) {
    throw new Error(`[c2-baseline-finalize] submissions directory not found: ${input.submissionsDir}`);
  }

  mkdirSync(input.scorecardsDir, { recursive: true });
  const resolutionPath = join(input.submissionsDir, "blind-resolution.json");
  if (existsSync(resolutionPath)) {
    throw new Error(
      `[c2-baseline-finalize] blind-resolution.json already exists in ${input.submissionsDir}. `
      + `If all scorecards in the resolution are present in ${input.scorecardsDir}, finalization is complete. `
      + `If some scorecards are missing (orphan from a crash between phases), remove this file and re-run: `
      + `the script will skip entries with existing durable scorecards and re-derive any orphans.`,
    );
  }
  const store = createFileBlindMapStore(input.blindMapDir);
  const files = readdirSync(input.submissionsDir)
    .filter((file) => file.endsWith(".json") && file !== "blind-resolution.json")
    .sort();

  if (files.length === 0) {
    throw new Error(
      `[c2-baseline-finalize] no submission files found in ${input.submissionsDir}. `
      + `Verify the reviewer submitted scorecards to the correct directory before finalizing.`,
    );
  }

  // P2 fix: Pre-validate EVERY submission through the full Zod schema before
  // any side effects. This catches malformed objects that pass a shape check
  // but fail strict schema validation (wrong types, missing required fields,
  // invalid enum values, etc.).
  const validatedSubmissions: C2BlindScoreSubmission[] = [];
  for (const file of files) {
    const submissionPath = join(input.submissionsDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(submissionPath, "utf8"));
    } catch (err) {
      throw new Error(
        `[c2-baseline-finalize] file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const schemaResult = C2BlindScoreSubmissionSchema.safeParse(parsed);
    if (!schemaResult.success) {
      throw new Error(
        `[c2-baseline-finalize] file ${file} failed C2BlindScoreSubmissionSchema validation: `
        + schemaResult.error.message.slice(0, 200),
      );
    }
    validatedSubmissions.push(schemaResult.data);
  }

  // P1 fix: Two-phase transactional finalization with crash recovery.
  //
  // Before phase 1, we load the blind map to identify entries that are
  // already finalized (from a prior partial run). Those entries are checked
  // for a corresponding durable scorecard: if it exists AND its hash binding
  // matches the map entry, they're skipped (already completed). If the map
  // is finalized but the scorecard is missing, the entry is an orphan from a
  // crash and is re-derived.
  //
  // Staging is rebuilt fresh on every run: any leftover .staging/ from a
  // crashed prior run is removed before the new run begins. This eliminates
  // the stale-staging-file collision that blocked recovery after a crash
  // during phase 1.
  //
  // Phase 1 (staging): Finalize each non-completed submission through the
  // blind map (assigned → finalized) and write scorecards to a staging dir.
  // Any failure aborts before durable publication.
  //
  // Phase 2 (publish): Move staged files to the durable scorecards directory
  // and write the resolution manifest. A crash between phases leaves the
  // map finalized + no durable; a re-run (after removing
  // blind-resolution.json) re-derives the orphan and publishes it.
  const stagingDir = join(input.scorecardsDir, ".staging");
  // Clear any stale staging from a crashed prior run.
  if (existsSync(stagingDir)) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  mkdirSync(stagingDir, { recursive: true });
  const resolutionEntries: Array<{ reviewId: string; runId: string; scorecardArtifactId: string }> = [];

  // Load map once for the recovery check.
  const mapEntries = await store.load();
  const mapByReviewId = new Map(mapEntries.map((e) => [e.reviewId, e]));

  try {
    for (const submission of validatedSubmissions) {
      const existingEntry = mapByReviewId.get(submission.reviewId);

      // Recovery check: if this entry is already finalized from a prior run,
      // check whether the durable scorecard exists AND its hash binding
      // matches the map entry. If both are true, skip (already completed).
      // If durable is missing, re-derive the orphan.
      if (existingEntry?.state === "finalized") {
        const scorecardArtifactId = `c2-scorecard-${submission.reviewId}`;
        const durablePath = join(input.scorecardsDir, `${scorecardArtifactId}.json`);
        if (existsSync(durablePath)) {
          // Hardening: verify the durable scorecard's hash binding matches
          // the map entry. Existence alone is not sufficient.
          const onDisk = JSON.parse(readFileSync(durablePath, "utf8")) as { runId?: string; runOutputSha256?: string };
          if (onDisk.runId !== existingEntry.runId || onDisk.runOutputSha256 !== existingEntry.runOutputSha256) {
            throw new Error(
              `[c2-baseline-finalize] durable scorecard ${scorecardArtifactId}.json has stale hash binding: ` +
              `runId=${onDisk.runId} (expected ${existingEntry.runId}), ` +
              `runOutputSha256=${onDisk.runOutputSha256?.slice(0, 12)}… (expected ${existingEntry.runOutputSha256.slice(0, 12)}…). ` +
              `The scorecard may have been tampered with or bound to the wrong run.`,
            );
          }
          // Hash binding verified — safe to skip.
          resolutionEntries.push({
            reviewId: submission.reviewId,
            runId: existingEntry.runId,
            scorecardArtifactId,
          });
          continue;
        }
        // Map finalized but scorecard missing — orphan from a crash.
        // Re-derive the scorecard from the submission + map entry.

        // Verify the submission's reviewer matches the assigned reviewer
        // before re-deriving. The normal path delegates to finalizeBlindScorecard
        // which enforces this; the recovery path must enforce it independently.
        if (submission.reviewerActorId !== existingEntry.assignedReviewerActorId) {
          throw new Error(
            `[c2-baseline-finalize] recovery: reviewer '${submission.reviewerActorId}' does not match ` +
            `assigned reviewer '${existingEntry.assignedReviewerActorId}' for reviewId ${submission.reviewId}. ` +
            `The submission may have been tampered with.`,
          );
        }

        const nowIso = (input.now ?? (() => new Date().toISOString()))();
        const scoredAt = typeof nowIso === "string" ? nowIso : nowIso();
        const allMeetsFloor = submission.scores.every((s) => s.score >= 3);
        const recoveredScorecard = {
          schemaVersion: "1.0" as const,
          artifactType: "c2-human-scorecard" as const,
          artifactId: scorecardArtifactId,
          runId: existingEntry.runId,
          runOutputSha256: existingEntry.runOutputSha256,
          reviewerActorId: submission.reviewerActorId,
          reviewerActorKind: "human" as const,
          blindedCondition: true as const,
          scores: submission.scores,
          implementationReady: allMeetsFloor,
          scoredAt,
        };
        C2HumanScorecardSchema.parse(recoveredScorecard);
        // Staging was rebuilt fresh above, so no duplicate-staging guard needed
        // on the recovery path — a collision would indicate a bug in the
        // submission deduplication, not a stale file.
        await writeDurableArtifact(stagingDir, `${scorecardArtifactId}.json`, canonicalJsonStringify(recoveredScorecard), durableBoundaryScan());
        resolutionEntries.push({
          reviewId: submission.reviewId,
          runId: existingEntry.runId,
          scorecardArtifactId,
        });
        continue;
      }

      // Normal path: finalize through the blind map.
      const scorecard = await finalizeBlindScorecard(submission, {
        store,
        now: input.now,
      });
      C2HumanScorecardSchema.parse(scorecard);

      const stagingPath = join(stagingDir, `${scorecard.artifactId}.json`);
      if (existsSync(stagingPath)) {
        throw new Error(
          `[c2-baseline-finalize] duplicate scorecard artifactId: ${scorecard.artifactId}`,
        );
      }
      // Write to staging (boundary-scanned, same as durable).
      await writeDurableArtifact(
        stagingDir,
        `${scorecard.artifactId}.json`,
        canonicalJsonStringify(scorecard),
        durableBoundaryScan(),
      );
      resolutionEntries.push({
        reviewId: submission.reviewId,
        runId: scorecard.runId,
        scorecardArtifactId: scorecard.artifactId,
      });
    }

    // Phase 2: Publish — move all staged files to the durable directory.
    for (const entry of resolutionEntries) {
      const staged = join(stagingDir, `${entry.scorecardArtifactId}.json`);
      const durable = join(input.scorecardsDir, `${entry.scorecardArtifactId}.json`);
      if (existsSync(durable)) {
        // Already published by a prior partial run — skip, don't overwrite.
        continue;
      }
      const data = readFileSync(staged);
      await writeDurableArtifact(
        input.scorecardsDir,
        `${entry.scorecardArtifactId}.json`,
        data.toString("utf-8"),
        durableBoundaryScan(),
      );
    }

    const nowIso = (input.now ?? (() => new Date().toISOString()))();
    const resolution = {
      schemaVersion: "1.0",
      artifactType: "c2-baseline-blind-resolution",
      artifactId: "c2-baseline-blind-resolution-v1",
      resolvedAt: nowIso,
      finalizedCount: resolutionEntries.length,
      resolution: resolutionEntries,
    };
    await writePrivateArtifact(
      input.submissionsDir,
      "blind-resolution.json",
      Buffer.from(canonicalJsonStringify(resolution), "utf8"),
    );
  } finally {
    // Clean up staging directory regardless of success or failure.
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return {
    finalizedCount: resolutionEntries.length,
    scorecardsDir: input.scorecardsDir,
    resolutionPath,
  };
}

async function main(): Promise<void> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await finalizeBaselineBlindScorecards({
    submissionsDir: join(repo, "eval/c2/baseline/blinded-submissions"),
    scorecardsDir: join(repo, "eval/c2/baseline/scorecards"),
    blindMapDir: join(repo, ".c2-private/c2/baseline/blind-map"),
  });
  console.error(`[c2-baseline-finalize] finalized ${result.finalizedCount} scorecards under ${result.scorecardsDir}`);
  console.error(`[c2-baseline-finalize] private resolution: ${result.resolutionPath}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    console.error(`[c2-baseline-finalize] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
