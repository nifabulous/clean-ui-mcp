/**
 * One-off: finalize the human-authored blind submissions into canonical
 * C2HumanScorecard files bound to (runId, runOutputSha256) via the private
 * blind map. The submissions were scored without seeing run metadata; this
 * step resolves the reversible map and atomically transitions each entry
 * assigned → finalized.
 *
 * Run: npx tsx scripts/finalize-blind-scorecards.mts
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  finalizeBlindScorecard,
  createFileBlindMapStore,
} from "../src/c2/review-packets.ts";
import { C2HumanScorecardSchema } from "../src/c2/evaluation-contracts.ts";
import { canonicalJsonStringify } from "../src/readiness/contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const SUBMISSIONS_DIR = join(REPO, "eval/c2/scorecards/blinded-submissions");
const SCORECARDS_DIR = join(REPO, "eval/c2/scorecards");
const PRIVATE_ROOT = join(REPO, ".c2-private");

async function main() {
  mkdirSync(SCORECARDS_DIR, { recursive: true });
  const store = createFileBlindMapStore(join(PRIVATE_ROOT, "c2/blind-map"));

  const files = readdirSync(SUBMISSIONS_DIR).filter((f) => f.endsWith(".json"));
  let finalized = 0;
  const resolution: Array<{ reviewId: string; runId: string; scorecardArtifactId: string }> = [];

  for (const file of files) {
    const submission = JSON.parse(readFileSync(join(SUBMISSIONS_DIR, file), "utf-8"));
    const reviewId = submission.reviewId;
    const scorecard = await finalizeBlindScorecard(submission, { store });

    // Re-validate the finalized scorecard through the canonical schema.
    C2HumanScorecardSchema.parse(scorecard);

    const outPath = join(SCORECARDS_DIR, `${scorecard.artifactId}.json`);
    writeFileSync(outPath, canonicalJsonStringify(scorecard), "utf-8");
    finalized++;
    resolution.push({
      reviewId,
      runId: scorecard.runId,
      scorecardArtifactId: scorecard.artifactId,
    });
    console.error(`  finalized: reviewId ${reviewId.slice(0, 8)}… → runId ${scorecard.runId}`);
  }

  // Write a resolution manifest mapping reviewId → runId. Written to the
  // blinded-submissions dir (NOT the scorecards dir) so loadCalibrationScorecards
  // doesn't try to parse it as a scorecard.
  writeFileSync(
    join(SUBMISSIONS_DIR, "blind-resolution.json"),
    canonicalJsonStringify({
      schemaVersion: "1.0",
      artifactType: "c2-blind-resolution",
      artifactId: "c2-blind-resolution-v1",
      resolvedAt: new Date().toISOString(),
      finalizedCount: finalized,
      resolution,
    }),
    "utf-8",
  );

  console.error(`\n[c2-finalize] finalized ${finalized} scorecards under ${SCORECARDS_DIR}`);
  console.error(`[c2-finalize] blind resolution manifest: eval/c2/scorecards/blinded-submissions/blind-resolution.json`);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
