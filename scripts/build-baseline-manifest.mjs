#!/usr/bin/env node
/**
 * build-baseline-manifest.mjs — generate and validate the canonical C2 Pass 3
 * frozen 25-case baseline manifest.
 *
 * The baseline tree spans TWO directories:
 *   - eval/c2/pilot/   — the 3 frozen pilot cases (stablecoin-home,
 *     public-marketing-migration, named-inspiration-safety)
 *   - eval/c2/baseline/ — the 22 new baseline cases (14 product + 4 migration
 *     + 4 safety)
 *
 * Each directory holds three artifact subdirs: briefs/, labels/, evidence/.
 * This script binds all 25 cases into a single content-addressed manifest so
 * downstream gates can detect drift: any byte change in any case file surfaces
 * as a manifest diff, and `--check` fails closed until the manifest is
 * regenerated.
 *
 * Determinism rules:
 *   - cases are sorted by caseId (lexicographic),
 *   - every input file is hashed over its EXACT on-disk bytes (SHA-256),
 *   - the manifest is serialized as two-space JSON + a single trailing
 *     newline, so regeneration is byte-identical on identical inputs,
 *   - the self-hash (`manifestSha256`) is computed over the canonical JSON of
 *     the manifest with `manifestSha256` set to `""`, then patched back in.
 *
 * Integrity rules:
 *   - exactly 25 cases: 15 product + 5 migration + 5 safety,
 *   - each brief's caseId + caseVersion must match its label,
 *   - each case must have exactly one matching gold-evidence descriptor whose
 *     caseId agrees,
 *   - migration briefs must declare a non-null sourceSnapshotRef (the snapshot
 *     file itself is deferred for baseline migration cases — the manifest pins
 *     the brief's declared ref; resolution happens at condition-build time),
 *   - non-migration briefs must carry a null sourceSnapshotRef,
 *   - no duplicate case IDs,
 *   - the frozen calibration ref's sha256 must match the actual file bytes,
 *   - the self-hash must verify,
 *   - the serialized manifest must pass the durable-artifact boundary scan,
 *   - no symbolic links anywhere in the scanned trees.
 *
 * Usage:
 *   node scripts/build-baseline-manifest.mjs            # write manifest
 *   node scripts/build-baseline-manifest.mjs --check    # compare, no write
 *
 * Exits 0 on success, non-zero on any integrity failure or stale manifest.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Deferred dist imports (same pattern as build-c2-pilot-manifest.mjs): the
// schema + hashing helpers live in compiled JS so the .mjs script can consume
// them without a TypeScript runtime. If dist isn't built yet (first build),
// strict per-artifact schema validation is skipped and the Vitest suite
// catches drift instead.
const caseContractsMod = await import("../dist/c2/case-contracts.js").catch(() => null);
const baselineManifestMod = await import("../dist/c2/baseline-manifest.js").catch(() => null);
const privateArtifactsMod = await import("../dist/c2/private-artifacts.js").catch(() => null);
const readinessMod = await import("../dist/readiness/contracts.js").catch(() => null);

const C2CaseBriefSchema = caseContractsMod?.C2CaseBriefSchema;
const C2DecisionLabelSchema = caseContractsMod?.C2DecisionLabelSchema;
const C2GoldEvidenceDescriptorSchema = caseContractsMod?.C2GoldEvidenceDescriptorSchema;
const C2BaselineManifestSchema = baselineManifestMod?.C2BaselineManifestSchema;
const computeManifestSha256 = baselineManifestMod?.computeManifestSha256;
const scanDurableArtifact = privateArtifactsMod?.scanDurableArtifact;
const canonicalJsonStringify = readinessMod?.canonicalJsonStringify;
const sha256Hex = readinessMod?.sha256Hex;

// ─── Constants ───────────────────────────────────────────────────────────────

const PILOT_REL = "eval/c2/pilot";
const BASELINE_REL = "eval/c2/baseline";
const MANIFEST_REL = `${BASELINE_REL}/manifest.json`;
const CALIBRATION_REL = "eval/c2/calibration/frozen.json";

const BRIEFS_DIR = "briefs";
const LABELS_DIR = "labels";
const EVIDENCE_DIR = "evidence";

const EXPECTED_CASE_COUNT = 25;
const EXPECTED_FAMILY_COUNTS = { product: 15, migration: 5, safety: 5 };
const REQUIRED_FAMILIES = new Set(["product", "migration", "safety"]);

// The spec-locked independent lane: current-grounded runs for exactly these
// five cases. Declared as data so drift from the spec-lock fails closed.
const REQUIRED_INDEPENDENT_CASE_IDS = [
  "stablecoin-home",
  "finance-news-story-detail",
  "public-marketing-migration",
  "safety-conflicting-evidence",
  "named-inspiration-safety",
];

const EXECUTION_MATRIX = {
  primaryConditions: ["brief-only", "current-grounded", "gold-evidence"],
  primaryCaseCount: 25,
  independentConditions: ["current-grounded"],
  independentCaseIds: [...REQUIRED_INDEPENDENT_CASE_IDS],
  totalPlannedRuns: 80, // 25×3 + 5×1
};

const BOUNDARY_SCAN_CONFIG = { secretValues: [], secretEnvNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] };

// ─── Errors ──────────────────────────────────────────────────────────────────

function fail(message) {
  throw new Error(`c2-baseline-manifest: ${message}`);
}

// ─── Async helpers ───────────────────────────────────────────────────────────

async function isSymlink(target) {
  return (await lstat(target)).isSymbolicLink();
}

function toPosix(p) {
  return p.split(sep).join("/");
}

async function sha256File(absPath) {
  const buf = await readFile(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

async function readJsonFile(absPath) {
  const buf = await readFile(absPath);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (cause) {
    throw new Error(
      `c2-baseline-manifest: invalid JSON at ${absPath}: ${cause.message}`,
      { cause },
    );
  }
}

// ─── Artifact reader ─────────────────────────────────────────────────────────

/**
 * Read every JSON file under `<root>/<treeRel>/<dir>/` (e.g. eval/c2/pilot/briefs/).
 *
 * Rejects symlinks, non-JSON entries, and entries whose parsed artifactType
 * disagrees with the directory's expected type. When the dist schemas are
 * available, additionally parses each file through its strict Zod schema so
 * malformed cases fail the build rather than surfacing at run time. Returns
 * each file's hash, parsed body, repo-relative POSIX path, and the tree it
 * came from ("pilot" | "baseline").
 */
async function readArtifactDir(root, treeRel, treeTag, dir, expectedArtifactType) {
  const absDir = resolve(root, treeRel, dir);
  if (!existsSync(absDir)) {
    // An empty artifact directory is not necessarily a failure — the caller
    // decides whether the resulting case set is complete.
    return [];
  }
  if (await isSymlink(absDir)) {
    fail(`artifact directory must not be a symbolic link: ${absDir}`);
  }

  const schemaMap = {
    "c2-case-brief": C2CaseBriefSchema,
    "c2-decision-label": C2DecisionLabelSchema,
    "c2-gold-evidence-descriptor": C2GoldEvidenceDescriptorSchema,
  };

  const names = await readdir(absDir);
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (seen.has(name)) fail(`duplicate filename ${name} under ${absDir}`);
    seen.add(name);
    if (!name.endsWith(".json")) {
      fail(`non-JSON entry "${name}" under ${treeRel}/${dir}/`);
    }
    const absPath = join(absDir, name);
    if (await isSymlink(absPath)) {
      fail(`symbolic link is forbidden in baseline tree: ${absPath}`);
    }
    const stat = statSync(absPath);
    if (!stat.isFile()) {
      fail(`expected a regular file at ${absPath}`);
    }
    const parsed = await readJsonFile(absPath);
    if (parsed.artifactType !== expectedArtifactType) {
      fail(
        `${treeRel}/${dir}/${name} has artifactType "${parsed.artifactType}", expected "${expectedArtifactType}"`,
      );
    }
    const schema = schemaMap[expectedArtifactType];
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        fail(
          `${treeRel}/${dir}/${name} fails strict schema for ${expectedArtifactType}: `
          + JSON.stringify(result.error.issues.map((i) => i.path.join(".") + ": " + i.message)),
        );
      }
    }
    if (typeof parsed.artifactId !== "string" || parsed.artifactId.length === 0) {
      fail(`${treeRel}/${dir}/${name} is missing artifactId`);
    }
    const sha256 = await sha256File(absPath);
    out.push({
      name,
      absPath,
      relPath: toPosix(relative(resolve(root), absPath)),
      sha256,
      parsed,
      treeTag,
    });
  }
  return out;
}

/**
 * Read all briefs/labels/evidence from BOTH the pilot and baseline trees and
 * return them as flat arrays tagged with their source tree.
 */
async function readAllArtifacts(root) {
  const [pilotBriefs, baselineBriefs] = await Promise.all([
    readArtifactDir(root, PILOT_REL, "pilot", BRIEFS_DIR, "c2-case-brief"),
    readArtifactDir(root, BASELINE_REL, "baseline", BRIEFS_DIR, "c2-case-brief"),
  ]);
  const [pilotLabels, baselineLabels] = await Promise.all([
    readArtifactDir(root, PILOT_REL, "pilot", LABELS_DIR, "c2-decision-label"),
    readArtifactDir(root, BASELINE_REL, "baseline", LABELS_DIR, "c2-decision-label"),
  ]);
  const [pilotEvidence, baselineEvidence] = await Promise.all([
    readArtifactDir(root, PILOT_REL, "pilot", EVIDENCE_DIR, "c2-gold-evidence-descriptor"),
    readArtifactDir(root, BASELINE_REL, "baseline", EVIDENCE_DIR, "c2-gold-evidence-descriptor"),
  ]);
  return {
    briefs: [...pilotBriefs, ...baselineBriefs],
    labels: [...pilotLabels, ...baselineLabels],
    evidence: [...pilotEvidence, ...baselineEvidence],
  };
}

// ─── Source snapshot resolution ──────────────────────────────────────────────

/**
 * Resolve the sourceSnapshot ref for a brief.
 *
 * The baseline manifest pins the brief's DECLARED sourceSnapshotRef — it does
 * not hash the snapshot file on disk. This is a deliberate difference from the
 * pilot manifest: the baseline defers snapshot resolution to condition-build
 * time, and several baseline migration snapshots are not yet present on disk
 * (the briefs carry placeholder hashes for them).
 *
 * For migration briefs: the sourceSnapshotRef must be non-null and carry the
 * `design-source-snapshot` artifactType. We project out artifactType and pin
 * the declared {artifactId, path, sha256} as the manifest's sourceSnapshot.
 *
 * For non-migration briefs: sourceSnapshotRef must be null/absent and the
 * manifest's sourceSnapshot is null.
 */
function resolveSourceSnapshot(brief, opts = {}, root = ".") {
  const ref = brief.parsed.sourceSnapshotRef;
  if (brief.parsed.family === "migration") {
    if (!ref || ref.artifactType !== "design-source-snapshot") {
      fail(
        `migration brief ${brief.name} must declare a design-source-snapshot sourceSnapshotRef`,
      );
    }
    if (typeof ref.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256)) {
      fail(
        `migration brief ${brief.name} sourceSnapshotRef.sha256 is not a valid 64-hex digest`,
      );
    }
    // When the snapshot file exists, verify the declared hash matches the actual
    // bytes. When it doesn't exist yet (placeholder sha), warn loudly so the
    // gap is visible — the manifest validates but execution will fail closed.
    const snapshotPath = resolve(root, ref.path);
    if (existsSync(snapshotPath)) {
      const actualSha = sha256Hex(readFileSync(snapshotPath));
      if (actualSha !== ref.sha256) {
        fail(
          `migration brief ${brief.name} sourceSnapshotRef.sha256 (${ref.sha256.slice(0, 12)}…) ` +
          `does not match the actual file hash (${actualSha.slice(0, 12)}…) at ${ref.path}`,
        );
      }
    } else if (!opts.allowMissingSnapshots) {
      fail(
        `migration brief ${brief.name} references snapshot at ${ref.path} but the file does not exist. ` +
        `Author the snapshot and update the brief's sourceSnapshotRef.sha256, or pass --allow-missing-snapshots.`,
      );
    } else {
      // Only warn — don't fail. This is for the current deferral period.
      console.error(
        `WARNING: migration brief ${brief.name} references snapshot at ${ref.path} which does not exist yet. ` +
        `The manifest will bind the declared placeholder hash; execution (prepare/run) will fail closed until the file is authored.`,
      );
    }
    return {
      artifactId: ref.artifactId,
      path: ref.path,
      sha256: ref.sha256,
    };
  }
  if (ref !== null && ref !== undefined) {
    fail(
      `non-migration brief ${brief.name} (family=${brief.parsed.family}) must not declare a sourceSnapshotRef`,
    );
  }
  return null;
}

// ─── Core assembly ───────────────────────────────────────────────────────────

/**
 * Build the canonical 25-case baseline manifest object from the pilot +
 * baseline trees at `<root>/eval/c2/{pilot,baseline}/`. Does not write anything
 * to disk.
 *
 * @param {string} root  absolute path to the repo root.
 * @returns {Promise<object>} the manifest object (caller serializes it).
 */
export async function buildBaselineManifest(root, opts = {}) {
  if (typeof root !== "string" || root.length === 0) {
    fail("root path is required");
  }

  const { briefs, labels, evidence } = await readAllArtifacts(root);

  // ── Reject duplicate case IDs before pairing ─────────────────────────────
  const seenBriefIds = new Set();
  for (const brief of briefs) {
    if (seenBriefIds.has(brief.parsed.caseId)) {
      fail(
        `duplicate brief caseId "${brief.parsed.caseId}" (files: ${briefs
          .filter((b) => b.parsed.caseId === brief.parsed.caseId)
          .map((b) => b.relPath)
          .join(", ")})`,
      );
    }
    seenBriefIds.add(brief.parsed.caseId);
  }
  const seenLabelIds = new Set();
  for (const label of labels) {
    if (seenLabelIds.has(label.parsed.caseId)) {
      fail(`duplicate label caseId "${label.parsed.caseId}"`);
    }
    seenLabelIds.add(label.parsed.caseId);
  }

  // ── Pair briefs ↔ labels by caseId ───────────────────────────────────────
  const briefByCaseId = new Map(briefs.map((b) => [b.parsed.caseId, b]));
  const labelByCaseId = new Map(labels.map((l) => [l.parsed.caseId, l]));

  for (const label of labels) {
    if (!briefByCaseId.has(label.parsed.caseId)) {
      fail(`orphan label "${label.relPath}" has no matching brief (caseId=${label.parsed.caseId})`);
    }
  }
  for (const brief of briefs) {
    if (!labelByCaseId.has(brief.parsed.caseId)) {
      fail(`brief "${brief.relPath}" has no matching label (caseId=${brief.parsed.caseId})`);
    }
  }

  // ── Build evidence lookup by caseId (exactly one descriptor per case) ─────
  const evidenceByCaseId = new Map();
  for (const desc of evidence) {
    if (evidenceByCaseId.has(desc.parsed.caseId)) {
      fail(
        `duplicate gold-evidence descriptor for caseId "${desc.parsed.caseId}" (files: ${evidence
          .filter((d) => d.parsed.caseId === desc.parsed.caseId)
          .map((d) => d.relPath)
          .join(", ")})`,
      );
    }
    evidenceByCaseId.set(desc.parsed.caseId, desc);
  }

  // ── Case count + family coverage ─────────────────────────────────────────
  if (briefs.length !== EXPECTED_CASE_COUNT) {
    fail(`expected ${EXPECTED_CASE_COUNT} briefs, found ${briefs.length}`);
  }
  const familyCounts = { product: 0, migration: 0, safety: 0 };
  for (const brief of briefs) {
    if (!REQUIRED_FAMILIES.has(brief.parsed.family)) {
      fail(`brief ${brief.relPath} has unknown family "${brief.parsed.family}"`);
    }
    familyCounts[brief.parsed.family]++;
  }
  for (const family of REQUIRED_FAMILIES) {
    if (familyCounts[family] !== EXPECTED_FAMILY_COUNTS[family]) {
      fail(
        `family count mismatch for "${family}": expected ${EXPECTED_FAMILY_COUNTS[family]}, found ${familyCounts[family]}`,
      );
    }
  }

  // ── Assemble case refs (sorted by caseId) ────────────────────────────────
  const sortedBriefs = [...briefs].sort((a, b) =>
    a.parsed.caseId < b.parsed.caseId ? -1 : a.parsed.caseId > b.parsed.caseId ? 1 : 0,
  );

  const cases = [];
  for (const brief of sortedBriefs) {
    const label = labelByCaseId.get(brief.parsed.caseId);
    if (brief.parsed.caseId !== label.parsed.caseId) {
      fail(`caseId mismatch between brief ${brief.relPath} and label ${label.relPath}`);
    }
    if (brief.parsed.caseVersion !== label.parsed.caseVersion) {
      fail(
        `caseVersion mismatch between brief ${brief.relPath} (v${brief.parsed.caseVersion}) and label ${label.relPath} (v${label.parsed.caseVersion})`,
      );
    }
    if (brief.parsed.schemaVersion !== "1.0") {
      fail(`brief ${brief.relPath} has unsupported schemaVersion "${brief.parsed.schemaVersion}"`);
    }

    const desc = evidenceByCaseId.get(brief.parsed.caseId);
    if (!desc) {
      fail(`missing gold-evidence descriptor for caseId "${brief.parsed.caseId}"`);
    }
    if (desc.parsed.caseId !== brief.parsed.caseId) {
      fail(
        `evidence descriptor ${desc.relPath} caseId "${desc.parsed.caseId}" does not match brief caseId "${brief.parsed.caseId}"`,
      );
    }

    const sourceSnapshot = resolveSourceSnapshot(brief, opts, root);

    cases.push({
      schemaVersion: "1.0",
      artifactType: "c2-case-package",
      artifactId: `c2-package-${brief.parsed.caseId}-v${brief.parsed.caseVersion}`,
      caseId: brief.parsed.caseId,
      caseVersion: brief.parsed.caseVersion,
      family: brief.parsed.family,
      brief: {
        artifactId: brief.parsed.artifactId,
        path: brief.relPath,
        sha256: brief.sha256,
      },
      label: {
        artifactId: label.parsed.artifactId,
        path: label.relPath,
        sha256: label.sha256,
      },
      sourceSnapshot,
      goldEvidenceDescriptor: {
        artifactId: desc.parsed.artifactId,
        path: desc.relPath,
        sha256: desc.sha256,
      },
    });
  }

  // Reject orphan evidence descriptors (every descriptor must bind to one case).
  const boundDescriptorPaths = new Set(cases.map((c) => c.goldEvidenceDescriptor.path));
  for (const desc of evidence) {
    if (!boundDescriptorPaths.has(desc.relPath)) {
      fail(`orphan gold-evidence descriptor ${desc.relPath} is not bound to any case`);
    }
  }

  // ── Frozen calibration file ref (hash the actual bytes) ──────────────────
  const calibrationAbs = resolve(root, CALIBRATION_REL);
  if (!existsSync(calibrationAbs)) {
    fail(`frozen calibration file not found at ${calibrationAbs}`);
  }
  if (await isSymlink(calibrationAbs)) {
    fail(`frozen calibration must not be a symbolic link: ${calibrationAbs}`);
  }
  const calibrationBytes = await readFile(calibrationAbs);
  const calibrationSha = createHash("sha256").update(calibrationBytes).digest("hex");
  // Parse to confirm it's well-formed JSON + extract the artifactId.
  let calibrationParsed;
  try {
    calibrationParsed = JSON.parse(calibrationBytes.toString("utf8"));
  } catch (cause) {
    fail(`frozen calibration is not valid JSON: ${cause.message}`);
  }
  if (typeof calibrationParsed.artifactId !== "string" || calibrationParsed.artifactId.length === 0) {
    fail(`frozen calibration is missing artifactId`);
  }
  const frozenCalibrationRef = {
    artifactId: calibrationParsed.artifactId,
    path: CALIBRATION_REL,
    sha256: calibrationSha,
  };

  // ── Envelope (without self-hash) ─────────────────────────────────────────
  const manifest = {
    schemaVersion: "1.0",
    artifactType: "c2-baseline-manifest",
    artifactId: "c2-baseline-v1",
    caseCount: cases.length,
    familyCounts: { product: familyCounts.product, migration: familyCounts.migration, safety: familyCounts.safety },
    cases,
    executionMatrix: EXECUTION_MATRIX,
    frozenCalibrationRef,
    manifestSha256: "", // patched below
  };

  // ── Self-hash ────────────────────────────────────────────────────────────
  if (typeof computeManifestSha256 !== "function") {
    fail(
      "computeManifestSha256 not available — dist/c2/baseline-manifest.js is missing or out of date. Run `npm run build` (tsc) first.",
    );
  }
  const { manifestSha256: _omit, ...manifestWithoutHash } = manifest;
  void _omit;
  manifest.manifestSha256 = computeManifestSha256(manifestWithoutHash);

  return manifest;
}

// ─── Serialization + check mode ──────────────────────────────────────────────

/**
 * Canonical manifest bytes: two-space-indented JSON + one trailing newline.
 * Stable across runs given identical input bytes.
 */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Validate a manifest object against the strict schema + boundary scan. Throws
 * on any failure. Used by both the write and --check paths so the on-disk file
 * is always gated by the full schema + boundary scan.
 */
function validateManifestObject(manifest) {
  if (!C2BaselineManifestSchema) {
    fail(
      "C2BaselineManifestSchema not available — dist/c2/baseline-manifest.js is missing or out of date. Run `npm run build` (tsc) first.",
    );
  }
  const result = C2BaselineManifestSchema.safeParse(manifest);
  if (!result.success) {
    fail(
      `manifest fails C2BaselineManifestSchema: `
      + JSON.stringify(result.error.issues.map((i) => i.path.join(".") + ": " + i.message)),
    );
  }
  // Boundary scan: the serialized manifest must carry only hashes + refs, no
  // prompt/evidence/raw content, no private paths, no configured secret values.
  if (typeof scanDurableArtifact !== "function") {
    fail(
      "scanDurableArtifact not available — dist/c2/private-artifacts.js is missing or out of date.",
    );
  }
  const canonical = serializeManifest(manifest);
  scanDurableArtifact(canonical, BOUNDARY_SCAN_CONFIG);
}

/**
 * Compare the canonical manifest bytes against the on-disk manifest. Throws
 * (without writing) when the on-disk file is missing or stale. Also re-runs
 * the schema + boundary scan so a hand-edited manifest that no longer parses
 * is caught even before byte comparison.
 *
 * @param {string} root  absolute path to the repo root.
 */
export async function checkBaselineManifest(root, opts = {}) {
  const manifest = await buildBaselineManifest(root, opts);
  validateManifestObject(manifest);

  const manifestAbs = resolve(root, MANIFEST_REL);
  if (await isSymlink(manifestAbs)) {
    fail(`manifest must not be a symbolic link: ${manifestAbs}`);
  }
  if (!existsSync(manifestAbs)) {
    fail(`baseline manifest is stale: missing ${MANIFEST_REL}`);
  }
  const onDisk = await readFile(manifestAbs, "utf8");
  const canonical = serializeManifest(manifest);
  if (onDisk !== canonical) {
    fail(`baseline manifest is stale: ${MANIFEST_REL} does not match canonical bytes`);
  }
}

// ─── Atomic write ────────────────────────────────────────────────────────────

/**
 * Write the manifest atomically: write to a temp sibling, fsync, then rename
 * over the destination. An interrupted write between fsync and rename leaves
 * only the temp file behind, never a truncated manifest.
 */
function writeManifestAtomic(root, bytes) {
  const manifestAbs = resolve(root, MANIFEST_REL);
  const dir = dirname(manifestAbs);
  const tmpPath = join(dir, `.manifest.${randomBytes(6).toString("hex")}.tmp`);

  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(tmpPath, bytes);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmpPath, manifestAbs);
  } catch (cause) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw cause;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const allowMissingSnapshots = argv.includes("--allow-missing-snapshots");
  const unknown = argv.filter((a) => a !== "--check" && a !== "--allow-missing-snapshots");
  if (unknown.length > 0) {
    console.error(`unknown argument(s): ${unknown.join(" ")}`);
    process.exit(1);
  }
  const root = process.cwd();

  if (check) {
    try {
      await checkBaselineManifest(root, { allowMissingSnapshots });
    } catch (cause) {
      console.error(cause.message);
      process.exit(1);
    }
    console.log(`c2-baseline-manifest: ${MANIFEST_REL} is up to date`);
    return;
  }

  let manifest;
  try {
    manifest = await buildBaselineManifest(root, { allowMissingSnapshots });
    validateManifestObject(manifest);
  } catch (cause) {
    console.error(cause.message);
    process.exit(1);
  }
  writeManifestAtomic(root, serializeManifest(manifest));
  console.log(
    `c2-baseline-manifest: wrote ${MANIFEST_REL} (${manifest.caseCount} cases, `
    + `manifestSha256=${manifest.manifestSha256.slice(0, 12)}…)`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
