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
import { C2HumanScorecardSchema } from "../src/c2/evaluation-contracts.ts";
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
  const store = createFileBlindMapStore(input.blindMapDir);
  const resolutionEntries: Array<{ reviewId: string; runId: string; scorecardArtifactId: string }> = [];
  const files = readdirSync(input.submissionsDir)
    .filter((file) => file.endsWith(".json") && file !== "blind-resolution.json")
    .sort();

  for (const file of files) {
    const submissionPath = join(input.submissionsDir, file);
    const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
    const scorecard = await finalizeBlindScorecard(submission, {
      store,
      now: input.now,
    });
    C2HumanScorecardSchema.parse(scorecard);

    const scorecardPath = join(input.scorecardsDir, `${scorecard.artifactId}.json`);
    if (existsSync(scorecardPath)) {
      throw new Error(
        `[c2-baseline-finalize] scorecard already exists: ${scorecardPath}; refusing to overwrite`,
      );
    }
    await writeDurableArtifact(
      input.scorecardsDir,
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

  const resolution = {
    schemaVersion: "1.0",
    artifactType: "c2-baseline-blind-resolution",
    artifactId: "c2-baseline-blind-resolution-v1",
    resolvedAt: (input.now ?? (() => new Date().toISOString()))(),
    finalizedCount: resolutionEntries.length,
    resolution: resolutionEntries,
  };
  await writePrivateArtifact(
    input.submissionsDir,
    "blind-resolution.json",
    Buffer.from(canonicalJsonStringify(resolution), "utf8"),
  );

  return {
    finalizedCount: resolution.finalizedCount,
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
