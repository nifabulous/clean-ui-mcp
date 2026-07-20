/**
 * One-off: generate metadata-blinded review packets for the 11 successful
 * C2 campaign runs. Each packet contains ONLY { reviewId, candidate } — no
 * runId, provider, model, condition, or caseId. The reversible map (reviewId
 * → runId) is written privately under .c2-private/c2/blind-map/.
 *
 * Run: npx tsx scripts/create-blinded-review-packets.mts
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBlindAssignment,
  buildBlindedReviewPacket,
  createFileBlindMapStore,
  shufflePackets,
} from "../src/c2/review-packets.ts";
import { C2CandidateArtifactSchema } from "../src/c2/candidate-contracts.ts";
import { C2EvaluationRunManifestV2Schema } from "../src/c2/evaluation-contracts.ts";
import { canonicalJsonStringify } from "../src/readiness/contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const RUNS_DIR = join(REPO, "eval/c2/runs");
const PRIVATE_RUNS_DIR = join(REPO, ".c2-private/runs");
const SCORECARDS_DIR = join(REPO, "eval/c2/scorecards");
const PACKETS_DIR = join(SCORECARDS_DIR, "blinded-packets");
const PRIVATE_ROOT = join(REPO, ".c2-private");

const REVIEWER = "codex-gold-reviewer";

async function main() {
  mkdirSync(PACKETS_DIR, { recursive: true });
  const store = createFileBlindMapStore(join(PRIVATE_ROOT, "c2/blind-map"));

  // Discover all runs with manifest + score (the same rule loadCalibrationRuns uses).
  const { readdirSync } = await import("node:fs");
  const runDirs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(RUNS_DIR, name, "manifest.json")) && existsSync(join(RUNS_DIR, name, "score.json")));

  const packets: Array<{ reviewId: string; packet: unknown }> = [];
  let count = 0;

  for (const runDir of runDirs) {
    const manifestPath = join(RUNS_DIR, runDir, "manifest.json");
    const manifest = C2EvaluationRunManifestV2Schema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));

    if (manifest.status !== "succeeded") continue;
    if (!manifest.parsedOutputSha256) continue;

    // Load the raw candidate (the model's parsed JSON output). Use the runDir
    // name (not manifest.runId) to locate the private raw response — the
    // fallback run's manifest.runId differs from its directory name.
    const rawPath = join(PRIVATE_RUNS_DIR, runDir, "raw-response.json");
    if (!existsSync(rawPath)) {
      console.error(`SKIP ${manifest.runId}: no raw-response.json`);
      continue;
    }
    const raw = readFileSync(rawPath, "utf-8");
    // The raw response may be fenced; parse it the same way the harness does.
    let candidateJson: unknown;
    try {
      const trimmed = raw.trim();
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```/);
      const body = fenced ? fenced[1]! : trimmed;
      candidateJson = JSON.parse(body);
    } catch (err) {
      console.error(`SKIP ${manifest.runId}: raw response not parseable JSON (${err instanceof Error ? err.message : err})`);
      continue;
    }
    const candidate = C2CandidateArtifactSchema.parse(candidateJson);

    const assignment = await createBlindAssignment(
      {
        runId: manifest.runId,
        runOutputSha256: manifest.parsedOutputSha256,
        candidate,
        assignedReviewerActorId: REVIEWER,
      },
      { store },
    );
    const packet = buildBlindedReviewPacket(assignment, candidate);
    packets.push({ reviewId: assignment.reviewId, packet });
    count++;
    console.error(`  blinded: ${manifest.runId} → reviewId ${assignment.reviewId.slice(0, 8)}…`);
  }

  // Shuffle the packets so the reviewer sees them in a random order (not the
  // filesystem/case order), defeating any ordering bias.
  const shuffled = shufflePackets(packets);

  for (let i = 0; i < shuffled.length; i++) {
    const { reviewId, packet } = shuffled[i]!;
    const path = join(PACKETS_DIR, `${reviewId}.json`);
    writeFileSync(path, canonicalJsonStringify(packet), "utf-8");
  }

  // Write a provenance manifest documenting the campaign state.
  const provenance = {
    schemaVersion: "1.0",
    artifactType: "c2-blinded-review-provenance",
    artifactId: "c2-blinded-review-provenance-v1",
    generatedAt: new Date().toISOString(),
    reviewerActorId: REVIEWER,
    packetCount: count,
    packetsDir: "eval/c2/scorecards/blinded-packets",
    privateBlindMapDir: ".c2-private/c2/blind-map",
    evidenceRule: {
      description: "Deterministic selection: final campaign successful runs + one documented fallback for public-marketing-migration/current-grounded/primary.",
      primaryLane: "complete (9/9 case×condition combinations have successful runs)",
      independentLane: "partial (2/3); stablecoin-home/current-grounded/independent unavailable due to repeat Claude truncation at the 4096-token provider ceiling",
      fallback: {
        runId: "c2-run-public-marketing-migration-current-grounded-primary-1-fallback",
        reason: "Final campaign's run for this case×condition failed stochastically (invalid URL in inspectedUrls). Fallback uses the prior campaign's successful artifact (same prompt, same fixes).",
      },
    },
    stochasticFailuresRecorded: [
      {
        campaign: "final (fence-fix)",
        runId: "c2-run-public-marketing-migration-current-grounded-primary-1",
        terminalReason: "validation-failed",
        cause: "OpenAI emitted an invalid URL in screenBlueprints[0].inspectedUrls. Stochastic — the same run succeeded in the prior campaign.",
      },
      {
        campaign: "final (fence-fix)",
        runId: "c2-run-stablecoin-home-current-grounded-independent-1",
        terminalReason: "parse-failed",
        cause: "Claude truncated at exactly 4096 output tokens (response ends mid-word). Repeat failure across two campaigns — provider ceiling, not a contract issue.",
      },
    ],
    deterministicFixesApplied: [
      "5d06dbe: selectedEntryIds corpus-prefix mismatch (bug #1)",
      "aac194a: authorityLanes StableId guidance (bug #2)",
      "e664449: retrieval limit enforced at resolver boundary (bug #4)",
      "7179889: assumptions/accessibility plain-strings clarification (bug #3)",
      "b2afb44: stale comment + pre-slice retrieval count observability",
      "c2b90b8: maxOutputTokens 4096 + surfaced provenance hash + strengthened authorityLanes",
      "d15bd47: independent-lane runId namespacing",
      "905fdb6: disable Claude adaptive thinking for C2 path + defensive thinking-only response handling",
      "f7ce77a: strip code fences with trailing prose in parseOneJsonObject",
      "ce12121: entry-point TDZ fix (propose path)",
    ],
  };
  writeFileSync(join(SCORECARDS_DIR, "blinded-review-provenance.json"), canonicalJsonStringify(provenance), "utf-8");

  console.error(`\n[c2-blind] generated ${count} blinded review packets under ${PACKETS_DIR}`);
  console.error(`[c2-blind] private blind map under .c2-private/c2/blind-map/`);
  console.error(`[c2-blind] provenance: eval/c2/scorecards/blinded-review-provenance.json`);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
