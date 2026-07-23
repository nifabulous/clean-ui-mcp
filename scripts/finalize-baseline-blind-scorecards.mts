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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
      `[c2-baseline-finalize] blind-resolution.json already exists in ${input.submissionsDir}; `
      + `refusing to overwrite. If this is a re-run after a partial failure, remove the file manually `
      + `after verifying the already-finalized scorecards are correct.`,
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

  // P1 fix: Two-phase transactional finalization.
  //
  // Phase 1 (staging): For each submission, finalize through the blind map
  // (assigned → finalized transition) and write the scorecard to a STAGING
  // directory. Any failure here aborts the entire batch before any durable
  // artifacts are published — the staging dir can be safely discarded.
  //
  // Phase 2 (publish): Atomically move all staged scorecards to the durable
  // scorecards directory and write the resolution manifest. This is a
  // best-effort publish: if the process dies mid-publish, the staged files
  // and the blind-map state are consistent (both finalized), and a re-run
  // after removing blind-resolution.json will skip already-finalized entries
  // via the existing scorecard-path guard and the map's finalized state.
  const stagingDir = join(input.scorecardsDir, ".staging");
  mkdirSync(stagingDir, { recursive: true });
  const resolutionEntries: Array<{ reviewId: string; runId: string; scorecardArtifactId: string }> = [];

  try {
    for (const submission of validatedSubmissions) {
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
