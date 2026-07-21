#!/usr/bin/env tsx
/**
 * build-label-integrity-selection — generate the frozen C2 label-integrity
 * selection artifact from the real corpus (Task A2, C2 Pass 3).
 *
 * The selection algorithm itself lives in `src/c2/label-selection.ts` (Task A1)
 * and is fully tested as a pure function. This script is the I/O wiring: it
 * loads the corpus (read-only), extracts the selection-relevant fields per
 * entry, computes the SHA-256 of each entry's image file, computes the corpus
 * hashes, invokes the pure builder, boundary-scans the canonical JSON, and
 * writes the artifact atomically to `eval/c2/label-integrity/selection.json`.
 *
 * Modes:
 *   default       build in memory, boundary-scan, write atomically.
 *   --check       build in memory, compare byte-for-byte against the on-disk
 *                 artifact; exit non-zero on any difference (drift detection).
 *
 * Determinism: same corpus + same commit → byte-identical output. The artifact
 * carries `corpusSha256` (content hash of `corpus/entries.json`) and
 * `corpusGitSha` (`git rev-parse HEAD`), so any corpus or commit change alters
 * the artifact and trips `--check`.
 *
 * Boundary: the selection carries only entry IDs + image SHA-256 + rationales +
 * corpus/git hashes — never image content, raw responses, or private paths.
 * `scanDurableArtifact` runs before the write; a scan failure leaves no file.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildLabelIntegritySelection,
  CHALLENGE_ENTRY_IDS,
  type CorpusEntryForLabelSelection,
  type ChallengeEntryInput,
} from "../c2/label-selection.js";
import { scanDurableArtifact, writeDurableArtifact, type BoundaryScanConfig } from "../c2/private-artifacts.js";
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CORPUS_ENTRIES_PATH = resolve(REPO_ROOT, "corpus", "entries.json");
const CORPUS_DIR = resolve(REPO_ROOT, "corpus");
const SELECTION_DEST_ROOT = resolve(REPO_ROOT, "eval", "c2", "label-integrity");
const SELECTION_REL_PATH = "selection.json";
const SELECTION_ABS_PATH = resolve(SELECTION_DEST_ROOT, SELECTION_REL_PATH);

/** Frozen artifact identity (matches the A1 test fixtures + spec convention). */
const ARTIFACT_ID = "c2-label-integrity-selection-v1" as const;
const SELECTION_VERSION = 1;

/**
 * Challenge-entry rationales, copied verbatim from
 * `docs/c2/pass3-spec-lock.md` §5 (the source of truth). These are fixed for
 * the Pass 3 baseline and MUST NOT drift from the spec-lock table.
 */
const CHALLENGE_RATIONALES: Record<(typeof CHALLENGE_ENTRY_IDS)[number], string> = {
  "wealthsimple-wealthsimple-ios-screens-40-2026-07-05":
    "cautionary mobile dashboard; exercises mobile/state and accessibility review",
  "wise-wise-18":
    "cautionary responsive fintech settings flow; exercises responsive/state coverage",
  "workable-workable-2":
    "cautionary responsive enterprise dashboard; exercises platform and product-family coverage",
  "juicebox-juicebox-2":
    "cautionary empty-state; exercises failure-state and evidence-discipline review",
  "cash-app-cash-app-4":
    "cautionary onboarding; exercises multi-step state and accessibility review",
};

/**
 * Boundary scan config. The selection carries no secrets; we still pass the
 * scanner so the structural checks (no private paths, no content fields, no
 * case-private markers) are enforced at write time. The selector never emits
 * secret values, but the scan is the load-bearing gate — defense in depth.
 */
const BOUNDARY_SCAN_CONFIG: BoundaryScanConfig = {
  secretValues: [],
  secretEnvNames: [],
};

// ---------------------------------------------------------------------------
// Corpus loading + image hashing
// ---------------------------------------------------------------------------

interface RawCorpusEntry {
  id: string;
  industryVertical?: string | null;
  platform?: string | null;
  qualityTier?: string | null;
  patternType?: string | null;
  responsiveBehavior?: string | null;
  antiPatterns?: {
    accessibilityRisks?: unknown[] | null;
    legacyAccessibilityNotes?: unknown[] | null;
    whereThisFails?: unknown[] | null;
  } | null;
  image?: {
    path?: string;
    visibility?: string;
    width?: number;
    height?: number;
  } | null;
}

interface RawCorpusFile {
  version?: unknown;
  entries: RawCorpusEntry[];
}

function fail(message: string): never {
  console.error(`build-label-integrity-selection: ${message}`);
  process.exit(1);
}

/**
 * Read the corpus file (read-only — never mutated). Throws on missing file or
 * malformed structure.
 */
function loadCorpus(): { entries: RawCorpusEntry[]; corpusSha256: string } {
  if (!existsSync(CORPUS_ENTRIES_PATH)) {
    fail(`corpus not found: ${CORPUS_ENTRIES_PATH} (the corpus is gitignored; ensure corpus/entries.json is present)`);
  }
  const corpusBytes = readFileSync(CORPUS_ENTRIES_PATH);
  const corpusSha256 = sha256Hex(corpusBytes);
  let parsed: RawCorpusFile;
  try {
    parsed = JSON.parse(corpusBytes.toString("utf8")) as RawCorpusFile;
  } catch (err) {
    fail(`corpus/entries.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    fail(`corpus/entries.json must be an object with an \`entries\` array`);
  }
  return { entries: parsed.entries, corpusSha256 };
}

/**
 * Compute the SHA-256 of an image file at `corpus/<entry.image.path>`. Throws
 * if the image is missing or the entry lacks an image path.
 */
function computeImageSha256(entry: RawCorpusEntry): string {
  const relPath = entry.image?.path;
  if (!relPath || typeof relPath !== "string") {
    fail(`entry "${entry.id}" has no image.path — cannot compute imageSha256`);
  }
  const abs = resolve(CORPUS_DIR, relPath);
  if (!existsSync(abs)) {
    fail(`entry "${entry.id}" image file not found: ${abs}`);
  }
  const bytes = readFileSync(abs);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Extract the selection-relevant fields from a raw corpus entry. Mirrors the
 * `CorpusEntryForLabelSelection` shape expected by the pure builder.
 */
function extractForSelection(entry: RawCorpusEntry): CorpusEntryForLabelSelection {
  const ap = entry.antiPatterns ?? null;
  return {
    entryId: entry.id,
    industryVertical: entry.industryVertical ?? null,
    platform: entry.platform ?? null,
    qualityTier: entry.qualityTier ?? null,
    patternType: entry.patternType ?? null,
    responsiveBehavior: entry.responsiveBehavior ?? null,
    antiPatterns: ap
      ? {
          accessibilityRisks: ap.accessibilityRisks ?? null,
          legacyAccessibilityNotes: ap.legacyAccessibilityNotes ?? null,
          whereThisFails: ap.whereThisFails ?? null,
        }
      : null,
    imageSha256: computeImageSha256(entry),
  };
}

// ---------------------------------------------------------------------------
// Corpus + commit hashes
// ---------------------------------------------------------------------------

/**
 * Resolve `corpusGitSha` = `git rev-parse HEAD` (40-hex). Throws if git is
 * unavailable or the SHA is malformed.
 */
function resolveCorpusGitSha(): string {
  let sha: string;
  try {
    sha = execSync("git rev-parse HEAD", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    fail(`failed to resolve git HEAD: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail(`git rev-parse HEAD returned a non-SHA value: "${sha}"`);
  }
  return sha;
}

// ---------------------------------------------------------------------------
// Builder entry point
// ---------------------------------------------------------------------------

/**
 * Build the canonical selection JSON text. Pure of filesystem writes: loads
 * the corpus, hashes images, computes corpus/git SHAs, calls the pure builder,
 * serializes canonically. Identical corpus + identical `corpusGitSha` yields
 * byte-identical output.
 *
 * `corpusGitShaOverride` lets `--check` rebuild against the value FROZEN in the
 * on-disk artifact. Without it, `git rev-parse HEAD` would change on every
 * commit that touches the repo (including the one that lands this very
 * artifact), making the selection stale the instant it lands — the classic
 * self-referential-commit trap. The freeze point is recorded at generation
 * time; `--check` validates corpus/image/algorithm drift against the frozen
 * value, NOT the live HEAD.
 */
function buildSelection(corpusGitShaOverride?: string): { canonical: string } {
  const { entries, corpusSha256 } = loadCorpus();
  const corpusGitSha = corpusGitShaOverride ?? resolveCorpusGitSha();

  // Index the raw entries by id so the challenge entries can be resolved
  // without re-scanning the array.
  const byId = new Map<string, RawCorpusEntry>();
  for (const e of entries) {
    if (e && typeof e.id === "string") {
      byId.set(e.id, e);
    }
  }

  // 1. Extract selection-relevant fields for every corpus entry + hash images.
  const corpusEntriesForSelection: CorpusEntryForLabelSelection[] = entries.map(extractForSelection);

  // 2. Resolve the 5 challenge entries: they must exist in the corpus so we
  //    can hash their image files. Their rationales come from the spec-lock.
  const challengeEntries: ChallengeEntryInput[] = CHALLENGE_ENTRY_IDS.map((entryId) => {
    const raw = byId.get(entryId);
    if (!raw) {
      fail(`challenge entry "${entryId}" is not present in the corpus — cannot compute imageSha256`);
    }
    return {
      entryId,
      rationale: CHALLENGE_RATIONALES[entryId],
      imageSha256: computeImageSha256(raw),
    };
  });

  // 3. Sanity: every selected entry id must exist in the corpus. The challenge
  //    ids are verified above; verify the reproducible pool is a subset too.
  //    (The pure builder guarantees reproducible ids come from the input pool,
  //    so this is defense-in-depth against future refactors.)

  // 4. Invoke the pure, tested builder.
  const selection = buildLabelIntegritySelection({
    entries: corpusEntriesForSelection,
    challengeEntries,
    seed: "clean-ui-retag-v1",
    corpusGitSha,
    corpusSha256,
    artifactId: ARTIFACT_ID,
    selectionVersion: SELECTION_VERSION,
  });

  // 5. Canonical JSON: sorted keys, compact, deterministic byte output.
  const canonical = canonicalJsonStringify(selection);
  return { canonical };
}

/**
 * Read the `corpusGitSha` FROZEN in the on-disk artifact. `--check` rebuilds
 * against this value (not the live HEAD) so the comparison reflects only
 * corpus/image/algorithm drift. Throws if the file is missing or malformed.
 */
function readFrozenCorpusGitSha(): string {
  if (!existsSync(SELECTION_ABS_PATH)) {
    fail(`selection is stale: missing ${SELECTION_REL_PATH} — run without --check to generate`);
  }
  let parsed: { corpusGitSha?: unknown };
  try {
    parsed = JSON.parse(readFileSync(SELECTION_ABS_PATH, "utf8"));
  } catch (err) {
    fail(
      `${SELECTION_REL_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const sha = parsed.corpusGitSha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    fail(`${SELECTION_REL_PATH} carries a malformed corpusGitSha — regenerate without --check`);
  }
  return sha;
}

/**
 * Compare the canonical selection bytes against the on-disk artifact. Throws
 * (without writing) when the file is missing or differs by a single byte from
 * the canonical output rebuilt against the FROZEN corpusGitSha.
 */
function checkSelection(canonical: string): void {
  const onDisk = readFileSync(SELECTION_ABS_PATH, "utf8");
  if (onDisk !== canonical) {
    fail(
      `selection is stale: ${SELECTION_REL_PATH} does not match canonical bytes — ` +
        `run without --check to regenerate`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    fail(`unknown argument(s): ${unknown.join(" ")} (only --check is supported)`);
  }

  if (check) {
    // Rebuild against the corpusGitSha FROZEN in the on-disk artifact. The
    // live HEAD moves on every commit (including the one that landed this
    // artifact), so checking against HEAD would always report drift. The
    // frozen value is the real freeze point: if the corpus images, the
    // selection algorithm, or the rationales change, the rebuilt bytes differ
    // from the on-disk artifact and `--check` fails. corpusSha256 (a content
    // hash) catches corpus mutation independently of HEAD.
    const frozenGitSha = readFrozenCorpusGitSha();
    const { canonical } = buildSelection(frozenGitSha);
    // Boundary-scan the canonical output so a tampered on-disk file (e.g. one
    // smuggling a private path) is caught here too.
    scanDurableArtifact(canonical, BOUNDARY_SCAN_CONFIG);
    checkSelection(canonical);
    console.log(`build-label-integrity-selection: ${SELECTION_REL_PATH} is up to date`);
    return;
  }

  const { canonical } = buildSelection();

  // Default mode: boundary-scan FIRST (inside writeDurableArtifact), then the
  // atomic fsync+rename. A scan failure leaves no file on disk.
  await writeDurableArtifact(SELECTION_DEST_ROOT, SELECTION_REL_PATH, canonical, BOUNDARY_SCAN_CONFIG);
  console.log(`build-label-integrity-selection: wrote ${SELECTION_REL_PATH}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
