#!/usr/bin/env node
/**
 * build-c2-pilot-manifest.mjs — generate and validate the canonical C2 Pass 1
 * pilot manifest.
 *
 * The pilot tree under eval/c2/pilot/ holds three separated case packages
 * (brief, label, optional source snapshot). This script binds them into a
 * single content-addressed manifest so that downstream gates can detect
 * drift: any byte change in any pilot file surfaces as a manifest diff,
 * and `--check` fails closed until the manifest is regenerated.
 *
 * Determinism rules:
 *   - packages are sorted by caseId (lexicographic),
 *   - every input file is hashed over its EXACT on-disk bytes (SHA-256),
 *   - the manifest is serialized as two-space JSON + a single trailing
 *     newline, so regeneration is byte-identical on identical inputs.
 *
 * Integrity rules:
 *   - exactly three cases, exactly one each of {migration, product, safety},
 *   - each brief's caseId + caseVersion must match its label,
 *   - the migration brief binds exactly one existing snapshot, and that
 *     snapshot's artifactId must match the brief's sourceSnapshotRef,
 *   - non-migration briefs must carry a null sourceSnapshotRef,
 *   - no orphan labels (label with no matching brief),
 *   - no orphan snapshots (snapshot with no matching migration brief),
 *   - no duplicate filenames within an artifact directory,
 *   - no extra artifact files at the pilot root,
 *   - no symbolic links anywhere in the pilot tree.
 *
 * Usage:
 *   node scripts/build-c2-pilot-manifest.mjs            # write manifest
 *   node scripts/build-c2-pilot-manifest.mjs --check    # compare, no write
 *
 * Exits 0 on success, non-zero on any integrity failure or stale manifest.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJsonStringify } from "../dist/readiness/contracts.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PILOT_REL = "eval/c2/pilot";
const MANIFEST_REL = `${PILOT_REL}/manifest.json`;
const BRIEFS_DIR = "briefs";
const LABELS_DIR = "labels";
const SNAPSHOTS_DIR = "source-snapshots";
const EVIDENCE_DIR = "evidence";
const ARTIFACT_DIRS = new Set([BRIEFS_DIR, LABELS_DIR, SNAPSHOTS_DIR, EVIDENCE_DIR]);

const REQUIRED_FAMILIES = new Set(["migration", "product", "safety"]);
const EXPECTED_CASE_COUNT = 3;

// Pilot-file artifactTypes mapped from their host directory. The migration
// snapshot lives alongside briefs/labels but carries its own artifactType
// field, so we trust the parsed JSON for the snapshot's type and only
// hard-assert directory → type for briefs and labels.
const DIR_TO_ARTIFACT_TYPE = {
  [BRIEFS_DIR]: "c2-case-brief",
  [LABELS_DIR]: "c2-decision-label",
  [SNAPSHOTS_DIR]: "design-source-snapshot",
  [EVIDENCE_DIR]: "c2-gold-evidence-descriptor",
};

// ─── Errors ──────────────────────────────────────────────────────────────────

function fail(message) {
  throw new Error(`c2-pilot-manifest: ${message}`);
}

// ─── Async helpers ───────────────────────────────────────────────────────────

async function isSymlink(target) {
  // lstat does not follow symlinks — that's exactly what we want.
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
      `c2-pilot-manifest: invalid JSON at ${absPath}: ${cause.message}`,
      { cause },
    );
  }
}

async function readDirEntries(absDir) {
  const names = await readdir(absDir);
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) fail(`duplicate filename ${name} under ${absDir}`);
    seen.add(name);
  }
  return names;
}

// ─── Core validation + assembly ──────────────────────────────────────────────

/**
 * Read every JSON file under `<root>/eval/c2/pilot/<dir>/`. Rejects symlinks,
 * non-JSON entries, and entries whose parsed artifactType disagrees with the
 * directory's expected type. Returns each file's hash, parsed body, and
 * POSIX-style repo-relative path.
 */
async function readArtifactDir(root, dir, expectedArtifactType) {
  const absDir = resolve(root, PILOT_REL, dir);
  if (!existsSync(absDir)) {
    // Empty artifact dirs are legitimate (e.g. a future pilot with no
    // migration). For the current pilot, snapshots always has one entry, but
    // the validation rules below catch a missing migration snapshot.
    return [];
  }
  if (await isSymlink(absDir)) {
    fail(`artifact directory must not be a symbolic link: ${absDir}`);
  }

  const names = await readDirEntries(absDir);
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      fail(`non-JSON entry "${name}" under ${dir}/`);
    }
    const absPath = join(absDir, name);
    if (await isSymlink(absPath)) {
      fail(`symbolic link is forbidden in pilot tree: ${absPath}`);
    }
    const stat = statSync(absPath);
    if (!stat.isFile()) {
      fail(`expected a regular file at ${absPath}`);
    }
    const parsed = await readJsonFile(absPath);
    if (parsed.artifactType !== expectedArtifactType) {
      fail(
        `${dir}/${name} has artifactType "${parsed.artifactType}", expected "${expectedArtifactType}"`,
      );
    }
    // P2 fix: parse through the strict schema so reviewer-only fields in a
    // brief (goldEvidenceIds, rubricAnchors, etc.) or malformed shapes are
    // rejected by the build-facing validator itself, not just by the separate
    // Vitest suite. Import is deferred so the .mjs script can run before tsc
    // builds the .js output.
    const schemaMap = {
      "c2-case-brief": "C2CaseBriefSchema",
      "c2-decision-label": "C2DecisionLabelSchema",
      "c2-gold-evidence-descriptor": "C2GoldEvidenceDescriptorSchema",
    };
    if (schemaMap[expectedArtifactType]) {
      const schemaName = schemaMap[expectedArtifactType];
      const mod = await import(`../dist/c2/case-contracts.js`).catch(() => null);
      if (mod && mod[schemaName]) {
        const result = mod[schemaName].safeParse(parsed);
        if (!result.success) {
          fail(`${dir}/${name} fails strict ${schemaName}: ${JSON.stringify(result.error.issues.map((i) => i.path.join(".") + ": " + i.message))}`);
        }
      }
      // If dist isn't built yet (first build), the Vitest suite catches it.
    }
    if (typeof parsed.artifactId !== "string" || parsed.artifactId.length === 0) {
      fail(`${dir}/${name} is missing artifactId`);
    }
    const sha256 = await sha256File(absPath);
    out.push({
      name,
      absPath,
      relPath: toPosix(relative(resolve(root), absPath)),
      sha256,
      parsed,
    });
  }
  return out;
}

/**
 * Resolve the source snapshot reference for a brief.
 *
 * Migration briefs MUST bind exactly one existing snapshot whose:
 *   - projectId matches the brief's caseId (so multiple migration cases could
 *     each carry their own snapshot without ambiguity), and
 *   - artifactId matches the brief's sourceSnapshotRef.artifactId.
 *
 * Non-migration briefs MUST carry a null sourceSnapshotRef. Any snapshot on
 * disk whose projectId matches a non-migration caseId is a stray binding and
 * is rejected here.
 *
 * Snapshots whose projectId does not match ANY case are reported as orphans
 * by assertNoOrphanSnapshots after every package has been assembled.
 */
async function resolveSourceSnapshot(brief, snapshots) {
  const ref = brief.parsed.sourceSnapshotRef;
  if (brief.parsed.family === "migration") {
    if (!ref || ref.artifactType !== "design-source-snapshot") {
      fail(`migration brief ${brief.name} must bind a design-source-snapshot ref`);
    }
    const candidates = snapshots.filter(
      (s) => s.parsed.projectId === brief.parsed.caseId,
    );
    if (candidates.length === 0) {
      fail(
        `migration brief ${brief.name} has no matching snapshot (projectId=${brief.parsed.caseId})`,
      );
    }
    if (candidates.length > 1) {
      fail(
        `migration brief ${brief.name} matches multiple snapshots: ${candidates.map((c) => c.name).join(", ")}`,
      );
    }
    const snap = candidates[0];
    if (snap.parsed.artifactId !== ref.artifactId) {
      fail(
        `migration brief ${brief.name} ref artifactId "${ref.artifactId}" does not match snapshot "${snap.parsed.artifactId}"`,
      );
    }
    return {
      artifactId: snap.parsed.artifactId,
      path: snap.relPath,
      sha256: snap.sha256,
    };
  }

  // Non-migration: no ref, and no snapshot file may share its caseId.
  if (ref !== null && ref !== undefined) {
    fail(
      `non-migration brief ${brief.name} (family=${brief.parsed.family}) must not bind a source snapshot`,
    );
  }
  const straySnapshot = snapshots.find(
    (s) => s.parsed.projectId === brief.parsed.caseId,
  );
  if (straySnapshot) {
    fail(
      `non-migration brief ${brief.name} has a stray matching snapshot ${straySnapshot.name}`,
    );
  }
  return null;
}

/**
 * After packages are built, confirm every snapshot on disk was bound to
 * exactly one migration brief. Catches orphan snapshots whose projectId
 * does not match any case.
 */
function assertNoOrphanSnapshots(packages, snapshots) {
  const boundPaths = new Set(
    packages
      .map((p) => p.sourceSnapshot)
      .filter((s) => s !== null)
      .map((s) => s.path),
  );
  for (const snap of snapshots) {
    if (!boundPaths.has(snap.relPath)) {
      fail(
        `orphan snapshot ${snap.name} is not bound to any migration brief`,
      );
    }
  }
}

// ─── Gold-evidence descriptor binding ────────────────────────────────────────

/**
 * Resolve a RFC 6901 JSON pointer against a parsed document. Empty pointer ""
 * returns the whole document. Segments support ~1 (/) and ~0 (~) escapes.
 * Throws on malformed pointers or paths that do not exist.
 */
function resolveJsonPointer(doc, pointer) {
  if (pointer === "") return doc;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    fail(`malformed JSON pointer: ${JSON.stringify(pointer)}`);
  }
  if (pointer.includes("//")) {
    fail(`JSON pointer contains an empty segment: ${JSON.stringify(pointer)}`);
  }
  const segments = pointer.slice(1).split("/").map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = doc;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") {
      fail(`JSON pointer ${pointer} descends into a non-object at segment "${seg}"`);
    }
    if (!Object.prototype.hasOwnProperty.call(current, seg)) {
      fail(`JSON pointer ${pointer} does not resolve (missing segment "${seg}")`);
    }
    current = current[seg];
  }
  if (current === undefined) {
    fail(`JSON pointer ${pointer} resolves to undefined`);
  }
  return current;
}

/**
 * Hash the canonical bytes of every resolved pointer target for one record.
 * The hash binds the exact bytes the descriptor points at, so mutating any
 * pointed-to content changes the binding hash without copying any reviewer
 * field into the brief or the manifest.
 */
function hashResolvedEvidence(sourceDoc, jsonPointers) {
  const resolved = jsonPointers.map((ptr) => resolveJsonPointer(sourceDoc, ptr));
  // Canonical serialization makes the hash stable regardless of key order in
  // the source JSON and resilient to whitespace differences.
  const bytes = canonicalJsonStringify(resolved);
  return createHash("sha256").update(Buffer.from(bytes, "utf-8")).digest("hex");
}

/**
 * Load + schema-validate every gold-evidence descriptor under evidence/.
 * Descriptors are plain JSON files validated through C2GoldEvidenceDescriptorSchema
 * (deferred dist import, same pattern as briefs/labels).
 */
async function readEvidenceDescriptors(root) {
  const absDir = resolve(root, PILOT_REL, EVIDENCE_DIR);
  if (!existsSync(absDir)) {
    fail(`gold-evidence directory missing: ${absDir}`);
  }
  if (await isSymlink(absDir)) {
    fail(`evidence directory must not be a symbolic link: ${absDir}`);
  }
  const names = await readDirEntries(absDir);
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      fail(`non-JSON entry "${name}" under ${EVIDENCE_DIR}/`);
    }
    const absPath = join(absDir, name);
    if (await isSymlink(absPath)) {
      fail(`symbolic link is forbidden in pilot tree: ${absPath}`);
    }
    const stat = statSync(absPath);
    if (!stat.isFile()) {
      fail(`expected a regular file at ${absPath}`);
    }
    const parsed = await readJsonFile(absPath);
    if (parsed.artifactType !== "c2-gold-evidence-descriptor") {
      fail(`${EVIDENCE_DIR}/${name} has artifactType "${parsed.artifactType}", expected "c2-gold-evidence-descriptor"`);
    }
    const mod = await import(`../dist/c2/case-contracts.js`).catch(() => null);
    if (mod && mod.C2GoldEvidenceDescriptorSchema) {
      const result = mod.C2GoldEvidenceDescriptorSchema.safeParse(parsed);
      if (!result.success) {
        fail(`${EVIDENCE_DIR}/${name} fails strict C2GoldEvidenceDescriptorSchema: ${JSON.stringify(result.error.issues.map((i) => i.path.join(".") + ": " + i.message))}`);
      }
    }
    if (typeof parsed.artifactId !== "string" || parsed.artifactId.length === 0) {
      fail(`${EVIDENCE_DIR}/${name} is missing artifactId`);
    }
    const sha256 = await sha256File(absPath);
    out.push({
      name,
      absPath,
      relPath: toPosix(relative(resolve(root), absPath)),
      sha256,
      parsed,
    });
  }
  return out;
}

/**
 * Build the gold-evidence binding section for the pilot manifest.
 *
 * For each case:
 *   - exactly one descriptor must exist on disk whose caseId matches,
 *   - the descriptor's record IDs must EXACTLY equal the label's goldEvidenceIds
 *     (set equality — no missing, no extra, no duplicates),
 *   - every record's sourceArtifactId must match the package's brief artifactId
 *     (product/safety) or the migration snapshot's artifactId (migration),
 *   - every declared JSON pointer must resolve against the bound source
 *     artifact's parsed body.
 *
 * Returns one binding per case, sorted by caseId. Each binding carries the
 * descriptor file ref plus, per record, a SHA-256 over the canonical bytes at
 * the declared pointers. The manifest does NOT carry the resolved content.
 */
async function buildGoldEvidenceBindings(packages, briefs, labels, snapshots, descriptors) {
  // Build lookups of source artifacts by artifactId for pointer resolution.
  // The briefs and snapshots are already read + schema-validated by the
  // caller; the binding step only needs their parsed bodies for resolution.
  const briefByArtifactId = new Map();
  for (const brief of briefs) {
    briefByArtifactId.set(brief.parsed.artifactId, brief);
  }
  const snapshotByArtifactId = new Map();
  for (const snap of snapshots) {
    snapshotByArtifactId.set(snap.parsed.artifactId, snap);
  }

  const descriptorByCaseId = new Map();
  for (const desc of descriptors) {
    if (descriptorByCaseId.has(desc.parsed.caseId)) {
      fail(`duplicate gold-evidence descriptor for caseId "${desc.parsed.caseId}" (files: ${descriptors.filter((d) => d.parsed.caseId === desc.parsed.caseId).map((d) => d.name).join(", ")})`);
    }
    descriptorByCaseId.set(desc.parsed.caseId, desc);
  }

  const sortedPackages = [...packages].sort((a, b) =>
    a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0,
  );

  const bindings = [];
  for (const pkg of sortedPackages) {
    const label = labels.find((l) => l.parsed.caseId === pkg.caseId);
    if (!label) {
      fail(`no label for case ${pkg.caseId} during gold-evidence binding`);
    }
    const desc = descriptorByCaseId.get(pkg.caseId);
    if (!desc) {
      fail(`missing gold-evidence descriptor for caseId "${pkg.caseId}"`);
    }
    if (desc.parsed.artifactId !== `c2-gold-evidence-${pkg.caseId}-v${pkg.caseVersion}`) {
      fail(
        `descriptor ${desc.name} artifactId "${desc.parsed.artifactId}" does not match convention c2-gold-evidence-${pkg.caseId}-v${pkg.caseVersion}`,
      );
    }
    if (desc.parsed.caseId !== pkg.caseId) {
      fail(`descriptor ${desc.name} caseId "${desc.parsed.caseId}" does not match package caseId "${pkg.caseId}"`);
    }

    // Exact-set equality between descriptor record IDs and label gold IDs.
    const recordIds = desc.parsed.records.map((r) => r.id);
    const goldIds = [...label.parsed.goldEvidenceIds];
    const recordSet = new Set(recordIds);
    const goldSet = new Set(goldIds);
    if (recordSet.size !== recordIds.length) {
      fail(`descriptor ${desc.name} has duplicate record IDs`);
    }
    if (goldSet.size !== goldIds.length) {
      // Should already be caught by the label schema; fail closed anyway.
      fail(`label ${label.name} has duplicate goldEvidenceIds`);
    }
    for (const id of goldIds) {
      if (!recordSet.has(id)) {
        fail(`descriptor ${desc.name} is missing gold ID "${id}" declared on label ${label.name}`);
      }
    }
    for (const id of recordIds) {
      if (!goldSet.has(id)) {
        fail(`descriptor ${desc.name} declares record "${id}" which is not a gold ID on label ${label.name}`);
      }
    }

    // Resolve every record's pointers against the bound source artifact.
    const allowedSourceArtifactIds = new Set([pkg.brief.artifactId]);
    if (pkg.sourceSnapshot !== null) {
      allowedSourceArtifactIds.add(pkg.sourceSnapshot.artifactId);
    }
    const recordBindings = [];
    for (const record of desc.parsed.records) {
      if (!allowedSourceArtifactIds.has(record.sourceArtifactId)) {
        fail(
          `descriptor ${desc.name} record "${record.id}" sourceArtifactId "${record.sourceArtifactId}" is neither the brief (${pkg.brief.artifactId}) nor the migration snapshot for case ${pkg.caseId}`,
        );
      }
      const source =
        briefByArtifactId.get(record.sourceArtifactId) ??
        snapshotByArtifactId.get(record.sourceArtifactId);
      if (!source) {
        fail(
          `descriptor ${desc.name} record "${record.id}" sourceArtifactId "${record.sourceArtifactId}" is not present on disk`,
        );
      }
      const resolvedSha256 = hashResolvedEvidence(source.parsed, record.jsonPointers);
      recordBindings.push({
        id: record.id,
        sourceArtifactId: record.sourceArtifactId,
        resolvedSha256,
      });
    }

    bindings.push({
      schemaVersion: "1.0",
      artifactType: "c2-gold-evidence-binding",
      artifactId: `c2-gold-binding-${pkg.caseId}-v${pkg.caseVersion}`,
      caseId: pkg.caseId,
      descriptor: {
        artifactId: desc.parsed.artifactId,
        path: desc.relPath,
        sha256: desc.sha256,
      },
      records: recordBindings,
    });
  }

  return bindings;
}

/**
 * Build the canonical pilot manifest object from the pilot tree at
 * `<root>/eval/c2/pilot/`. Does not write anything to disk.
 *
 * @param {string} root  absolute path to the repo root.
 * @returns {Promise<object>} the manifest object (caller serializes it).
 */
export async function buildPilotManifest(root) {
  if (typeof root !== "string" || root.length === 0) {
    fail("root path is required");
  }
  const pilotAbs = resolve(root, PILOT_REL);
  if (!existsSync(pilotAbs)) fail(`pilot directory not found at ${pilotAbs}`);
  if (await isSymlink(pilotAbs)) {
    fail(`pilot root must not be a symbolic link: ${pilotAbs}`);
  }

  // Pilot root must contain ONLY the three artifact dirs (+ the manifest, when
  // present). Anything else is an unexpected artifact.
  const rootEntries = await readdir(pilotAbs);
  for (const entry of rootEntries) {
    if (entry === "manifest.json") continue;
    if (!ARTIFACT_DIRS.has(entry)) {
      fail(`unexpected entry in pilot root: ${entry}`);
    }
  }

  // ── Read + validate each artifact directory ──────────────────────────────
  const briefs = await readArtifactDir(root, BRIEFS_DIR, DIR_TO_ARTIFACT_TYPE[BRIEFS_DIR]);
  const labels = await readArtifactDir(root, LABELS_DIR, DIR_TO_ARTIFACT_TYPE[LABELS_DIR]);
  const snapshots = await readArtifactDir(root, SNAPSHOTS_DIR, DIR_TO_ARTIFACT_TYPE[SNAPSHOTS_DIR]);
  const descriptors = await readEvidenceDescriptors(root);

  // ── Reject duplicate case IDs before pairing (P1 fix) ─────────────────────
  // Maps silently overwrite duplicates, allowing two packages with the same
  // case ID to be blessed. Reject explicitly.
  const seenBriefIds = new Set();
  for (const brief of briefs) {
    if (seenBriefIds.has(brief.parsed.caseId)) {
      fail(`duplicate brief caseId "${brief.parsed.caseId}" (files: ${briefs.filter((b) => b.parsed.caseId === brief.parsed.caseId).map((b) => b.name).join(", ")})`);
    }
    seenBriefIds.add(brief.parsed.caseId);
  }
  const seenLabelIds = new Set();
  for (const label of labels) {
    if (seenLabelIds.has(label.parsed.caseId)) {
      fail(`duplicate label caseId "${label.parsed.caseId}" (files: ${labels.filter((l) => l.parsed.caseId === label.parsed.caseId).map((l) => l.name).join(", ")})`);
    }
    seenLabelIds.add(label.parsed.caseId);
  }

  // ── Pair briefs ↔ labels by caseId ───────────────────────────────────────
  const briefByCaseId = new Map(briefs.map((b) => [b.parsed.caseId, b]));
  const labelByCaseId = new Map(labels.map((l) => [l.parsed.caseId, l]));

  for (const label of labels) {
    if (!briefByCaseId.has(label.parsed.caseId)) {
      fail(`orphan label "${label.name}" has no matching brief (caseId=${label.parsed.caseId})`);
    }
  }
  for (const brief of briefs) {
    if (!labelByCaseId.has(brief.parsed.caseId)) {
      fail(`brief "${brief.name}" has no matching label (caseId=${brief.parsed.caseId})`);
    }
  }

  // ── Case count + family coverage ─────────────────────────────────────────
  if (briefs.length !== EXPECTED_CASE_COUNT) {
    fail(`expected ${EXPECTED_CASE_COUNT} briefs, found ${briefs.length}`);
  }
  const families = new Set(briefs.map((b) => b.parsed.family));
  for (const required of REQUIRED_FAMILIES) {
    if (!families.has(required)) {
      fail(`missing required family "${required}"`);
    }
  }
  if (families.size !== REQUIRED_FAMILIES.size) {
    fail(`unexpected family set: ${[...families].sort().join(", ")}`);
  }

  // ── Assemble package records (sorted by caseId) ──────────────────────────
  const sortedBriefs = [...briefs].sort((a, b) =>
    a.parsed.caseId < b.parsed.caseId ? -1 : a.parsed.caseId > b.parsed.caseId ? 1 : 0,
  );

  const packages = [];
  for (const brief of sortedBriefs) {
    const label = labelByCaseId.get(brief.parsed.caseId);
    if (brief.parsed.caseId !== label.parsed.caseId) {
      fail(`caseId mismatch between brief ${brief.name} and label ${label.name}`);
    }
    if (brief.parsed.caseVersion !== label.parsed.caseVersion) {
      fail(
        `caseVersion mismatch between brief ${brief.name} (v${brief.parsed.caseVersion}) and label ${label.name} (v${label.parsed.caseVersion})`,
      );
    }
    if (brief.parsed.schemaVersion !== "1.0") {
      fail(`brief ${brief.name} has unsupported schemaVersion "${brief.parsed.schemaVersion}"`);
    }

    const sourceSnapshot = await resolveSourceSnapshot(brief, snapshots);

    packages.push({
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
    });
  }

  // ── Snapshot orphan check (post-assembly) ────────────────────────────────
  assertNoOrphanSnapshots(packages, snapshots);

  // ── Gold-evidence descriptor binding ─────────────────────────────────────
  // One binding per case; record IDs must exactly equal each label's
  // goldEvidenceIds, every sourceArtifactId must match the package's brief or
  // migration snapshot, and every JSON pointer must resolve. Unknown pointers
  // or IDs fail closed here, before any run can begin.
  const goldEvidenceBindings = await buildGoldEvidenceBindings(
    packages,
    briefs,
    labels,
    snapshots,
    descriptors,
  );

  // Reject orphan descriptors: every descriptor must bind to exactly one case.
  const boundDescriptorPaths = new Set(goldEvidenceBindings.map((b) => b.descriptor.path));
  for (const desc of descriptors) {
    if (!boundDescriptorPaths.has(desc.relPath)) {
      fail(`orphan gold-evidence descriptor ${desc.name} is not bound to any case`);
    }
  }

  // ── Envelope ─────────────────────────────────────────────────────────────
  return {
    schemaVersion: "1.0",
    artifactType: "c2-pilot-manifest",
    artifactId: "c2-pass1-pilot-v1",
    manifestVersion: 1,
    caseCount: packages.length,
    families: [...families].sort(),
    packages,
    goldEvidenceBindings,
  };
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
 * Compare the canonical manifest bytes against the on-disk manifest. Throws
 * (without writing) when the on-disk file is missing or stale.
 *
 * @param {string} root  absolute path to the repo root.
 */
export async function checkPilotManifest(root) {
  // buildPilotManifest already re-validates every input file and rejects
  // orphan snapshots, so a successful build means the canonical bytes are
  // well-formed; we only need to compare them against the on-disk file.
  const manifest = await buildPilotManifest(root);

  const manifestAbs = resolve(root, MANIFEST_REL);
  if (await isSymlink(manifestAbs)) {
    fail(`manifest must not be a symbolic link: ${manifestAbs}`);
  }
  if (!existsSync(manifestAbs)) {
    fail(`pilot manifest is stale: missing ${MANIFEST_REL}`);
  }
  const onDisk = await readFile(manifestAbs, "utf8");
  const canonical = serializeManifest(manifest);
  if (onDisk !== canonical) {
    fail(`pilot manifest is stale: ${MANIFEST_REL} does not match canonical bytes`);
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
  const dir = resolve(root, PILOT_REL);
  const tmpPath = join(dir, `.manifest.${randomBytes(6).toString("hex")}.tmp`);

  // P2 fix: wrap the ENTIRE write/fsync/close/rename sequence so the temp
  // file is removed on ANY pre-rename failure (not just rename failure).
  const fd = openSync(tmpPath, "w");
  try {
    writeFileSync(tmpPath, bytes);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmpPath, manifestAbs);
  } catch (cause) {
    // Close the fd if still open (closeSync is idempotent-safe to attempt).
    try { closeSync(fd); } catch { /* already closed */ }
    // Remove the temp file on every failure path.
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw cause;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const root = process.cwd();

  if (check) {
    try {
      await checkPilotManifest(root);
    } catch (cause) {
      console.error(cause.message);
      process.exit(1);
    }
    console.log(`c2-pilot-manifest: ${MANIFEST_REL} is up to date`);
    return;
  }

  let manifest;
  try {
    manifest = await buildPilotManifest(root);
  } catch (cause) {
    console.error(cause.message);
    process.exit(1);
  }
  writeManifestAtomic(root, serializeManifest(manifest));
  console.log(`c2-pilot-manifest: wrote ${MANIFEST_REL} (${manifest.caseCount} cases)`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
