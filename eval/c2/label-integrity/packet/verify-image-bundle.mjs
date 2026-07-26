#!/usr/bin/env node
/**
 * verify-image-bundle — preflight: verify every delivered screenshot PNG
 * against the cryptographic hash pinned in selection.json.
 *
 * The image bundle (corpus/images-private/) is gitignored and delivered
 * separately. Without this check, a stale or swapped image at a valid path
 * would produce labels that pass validation while referring to the wrong
 * screenshot. This script closes that gap by hashing each PNG and comparing
 * to selection.json's imageSha256.
 *
 * Usage:
 *   node eval/c2/label-integrity/packet/verify-image-bundle.mjs
 *   node eval/c2/label-integrity/packet/verify-image-bundle.mjs --quiet   # exit code only
 *
 * Exit codes:
 *   0  all 40 images present and hash-verified
 *   1  one or more images missing or hash-mismatched
 *   2  usage error / selection.json not found
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SELECTION = join(REPO, "eval/c2/label-integrity/selection.json");
const CORPUS_PRIVATE = join(REPO, "corpus/images-private");

const args = process.argv.slice(2);
const quiet = args.includes("--quiet") || args.includes("-q");

if (!existsSync(SELECTION)) {
  if (!quiet) console.error(`error: selection.json not found at ${SELECTION}`);
  process.exit(2);
}

// Load the frozen corpus snapshot to resolve entryId → image path. The
// selection binds to a snapshot via corpusSha256; the snapshot carries the
// image.path field for each entry.
const selection = JSON.parse(readFileSync(SELECTION, "utf8"));
const SNAPSHOT_DIR = join(REPO, ".c2-private/corpus-snapshots", selection.corpusSha256);
const SNAPSHOT_FILE = join(SNAPSHOT_DIR, "entries.json");

// If the private snapshot is absent (e.g. a fresh checkout without .c2-private),
// fall back to resolving image paths from the selection's entryIds against the
// live corpus/entries.json — but warn, because the live corpus may have drifted.
let imagePaths;
if (existsSync(SNAPSHOT_FILE)) {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  const byId = new Map(snapshot.entries.map((e) => [e.id, e]));
  imagePaths = selection.entries.map((entry) => ({
    entryId: entry.entryId,
    expectedSha: entry.imageSha256,
    absPath: join(REPO, "corpus", byId.get(entry.entryId)?.image?.path ?? ""),
  }));
} else {
  // Fallback: try the live corpus. Less rigorous but lets the check run.
  const liveCorpus = join(REPO, "corpus/entries.json");
  if (!existsSync(liveCorpus)) {
    if (!quiet) {
      console.error(`error: cannot resolve image paths — neither the frozen snapshot (${SNAPSHOT_FILE}) nor the live corpus (${liveCorpus}) exists.`);
      console.error(`       The frozen snapshot lives under .c2-private/ (gitignored). Deliver it alongside the image bundle.`);
    }
    process.exit(1);
  }
  const corpus = JSON.parse(readFileSync(liveCorpus, "utf8"));
  const byId = new Map(corpus.entries.map((e) => [e.id, e]));
  imagePaths = selection.entries.map((entry) => ({
    entryId: entry.entryId,
    expectedSha: entry.imageSha256,
    absPath: join(REPO, "corpus", byId.get(entry.entryId)?.image?.path ?? ""),
  }));
  if (!quiet) {
    console.error("warning: frozen snapshot not found — resolving paths from the live corpus. Run prepare first for hash-bound path resolution.");
  }
}

let missing = 0;
let mismatched = 0;
const failures = [];

for (const { entryId, expectedSha, absPath } of imagePaths) {
  if (!existsSync(absPath)) {
    missing++;
    failures.push(`MISSING  ${entryId}  ${absPath.replace(REPO + "/", "")}`);
    continue;
  }
  const actualSha = createHash("sha256").update(readFileSync(absPath)).digest("hex");
  if (actualSha !== expectedSha) {
    mismatched++;
    failures.push(`HASHFAIL ${entryId}  expected ${expectedSha.slice(0, 12)}… got ${actualSha.slice(0, 12)}…`);
  }
}

if (!quiet) {
  const ok = imagePaths.length - missing - mismatched;
  console.log(`image-bundle preflight: ${ok}/${imagePaths.length} verified`);
  if (missing > 0) console.log(`  missing:    ${missing}`);
  if (mismatched > 0) console.log(`  hash fails: ${mismatched}`);
  for (const f of failures) console.log(`  ${f}`);
}

if (missing > 0 || mismatched > 0) {
  if (!quiet) {
    console.error(`\nerror: image bundle preflight failed (${missing} missing, ${mismatched} hash-mismatched).`);
    console.error("       Labels produced against wrong or missing screenshots would pass validation but measure the wrong screens.");
    console.error("       Deliver the correct image bundle before labeling or validation.");
  }
  process.exit(1);
}

process.exit(0);
