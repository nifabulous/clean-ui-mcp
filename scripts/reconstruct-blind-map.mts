/**
 * One-off: reconstruct the blind map from the original reviewIds (preserved in
 * the human submissions) + the known runId mapping. The original map was lost
 * when regenerating with a corrected reviewer ID; this rebuilds it with the
 * correct reviewer ID and the original reviewIds so finalizeBlindScorecard
 * can resolve each submission.
 *
 * The reviewId → runId mapping is reconstructed from the packet-generation log
 * (the assignments were created in run-dir order before shuffling).
 *
 * Run: npx tsx scripts/reconstruct-blind-map.mts
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonStringify } from "../src/readiness/contracts.ts";
import { sha256Hex } from "../src/readiness/contracts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const RUNS_DIR = join(REPO, "eval/c2/runs");
const PRIVATE_RUNS_DIR = join(REPO, ".c2-private/runs");

const REVIEWER = "codex-gold-reviewer";

// Reconstructed reviewId → runDir mapping (runDir is the directory under
// eval/c2/runs/ holding the manifest+score). The manifest INSIDE each dir
// carries the canonical runId.
const MAPPING: Array<{ reviewId: string; runDir: string }> = [
  { reviewId: "09d66dbf-1739-41d4-b595-60168d415a3a", runDir: "c2-run-named-inspiration-safety-brief-only-primary-1" },
  { reviewId: "2127239c-629f-4d4f-8587-0ac1bf6c2afa", runDir: "c2-run-named-inspiration-safety-current-grounded-independent-1" },
  { reviewId: "e9e21ba4-0eff-4737-ad30-7a85cd5ed497", runDir: "c2-run-named-inspiration-safety-current-grounded-primary-1" },
  { reviewId: "1f91a228-2f63-4ead-a978-e02b59a7f81a", runDir: "c2-run-named-inspiration-safety-gold-evidence-primary-1" },
  { reviewId: "d96f5097-9adf-47fd-a64c-056a3d137cdf", runDir: "c2-run-public-marketing-migration-brief-only-primary-1" },
  { reviewId: "1e8eae27-de40-4e87-8ed1-e98980faece4", runDir: "c2-run-public-marketing-migration-current-grounded-independent-1" },
  { reviewId: "b7c4509e-b6fe-4279-b8b4-a20c217a462d", runDir: "c2-run-public-marketing-migration-current-grounded-primary-1-fallback" },
  { reviewId: "d5a420c3-8913-4662-9710-5a9d545c0c7a", runDir: "c2-run-public-marketing-migration-gold-evidence-primary-1" },
  { reviewId: "36043344-15cf-444d-b970-2ec7e1a19b4d", runDir: "c2-run-stablecoin-home-brief-only-primary-1" },
  { reviewId: "42ef4f4b-1a8e-4f27-be82-d586f12570e9", runDir: "c2-run-stablecoin-home-current-grounded-primary-1" },
  { reviewId: "b2bc0e8c-1b08-4776-baab-71e0852658e4", runDir: "c2-run-stablecoin-home-gold-evidence-primary-1" },
];

function main() {
  const blindMapDir = join(REPO, ".c2-private/c2/blind-map");
  mkdirSync(blindMapDir, { recursive: true });

  const entries = [];
  for (const { reviewId, runDir } of MAPPING) {
    const manifest = JSON.parse(readFileSync(join(RUNS_DIR, runDir, "manifest.json"), "utf-8"));
    const runId = manifest.runId;
    const runOutputSha256 = manifest.rawOutputSha256;
    if (!runOutputSha256) {
      throw new Error(`run ${runId} has no parsedOutputSha256 (not succeeded?)`);
    }
    entries.push({
      reviewId,
      runId,
      runOutputSha256,
      assignedReviewerActorId: REVIEWER,
      state: "assigned",
    });
    console.error(`  mapped: ${reviewId.slice(0, 8)}… → ${runId}`);
  }

  const mapPath = join(blindMapDir, "blind-map.json");
  writeFileSync(mapPath, canonicalJsonStringify(entries), "utf-8");
  console.error(`\n[c2-reconstruct] wrote ${entries.length} blind-map entries to ${mapPath}`);
}

main();
