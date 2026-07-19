import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildPilotManifest, checkPilotManifest } from "./build-c2-pilot-manifest.mjs";

// Tests for the canonical C2 pilot manifest generator. The generator binds the
// three pilot case packages (brief + label + optional source snapshot) under
// eval/c2/pilot/ into a single content-addressed manifest.
//
// The happy-path test exercises the REAL repo pilot tree (process.cwd()). The
// negative tests copy the real pilot files into a fresh temp directory and
// inject a single defect, so the tracked pilot files are never mutated.

const REPO_ROOT = process.cwd();
const PILOT_SRC = resolve(REPO_ROOT, "eval/c2/pilot");

// Expected canonical caseId ordering (lexicographic). Hard-coded so a future
// caseId rename shows up as a deliberate diff rather than a silent reorder.
const EXPECTED_CASE_ORDER = [
  "named-inspiration-safety",
  "public-marketing-migration",
  "stablecoin-home",
];

const SHA256 = /^[0-9a-f]{64}$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Copy the real pilot tree into <dest>/eval/c2/pilot/ so a temp directory can
// stand in for the repo root. Returns the temp root to pass to the generator.
function copyPilotIntoTemp(prefix) {
  const dest = mkdtempSync(join(tmpdir(), prefix));
  const target = join(dest, "eval/c2/pilot");
  for (const sub of ["briefs", "labels", "source-snapshots"]) {
    mkdirSync(join(target, sub), { recursive: true });
    for (const name of readdirSync(join(PILOT_SRC, sub))) {
      copyFileSync(join(PILOT_SRC, sub, name), join(target, sub, name));
    }
  }
  return dest;
}

describe("build-c2-pilot-manifest", () => {
  it("builds packages in caseId order with canonical file hashes", async () => {
    const manifest = await buildPilotManifest(REPO_ROOT);

    expect(manifest.schemaVersion).toBe("1.0");
    expect(manifest.artifactType).toBe("c2-pilot-manifest");
    expect(manifest.artifactId).toBe("c2-pass1-pilot-v1");
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.caseCount).toBe(3);
    expect(manifest.families).toEqual(["migration", "product", "safety"]);

    expect(
      manifest.packages.map((p) => p.caseId),
    ).toEqual(EXPECTED_CASE_ORDER);

    for (const pkg of manifest.packages) {
      expect(pkg.schemaVersion).toBe("1.0");
      expect(pkg.artifactType).toBe("c2-case-package");
      expect(pkg.artifactId).toBe(`c2-package-${pkg.caseId}-v${pkg.caseVersion}`);
      expect(pkg.brief.sha256).toMatch(SHA256);
      expect(pkg.label.sha256).toMatch(SHA256);
      expect(pkg.brief.path).toMatch(/^eval\/c2\/pilot\/briefs\//);
      expect(pkg.label.path).toMatch(/^eval\/c2\/pilot\/labels\//);
    }

    const migration = manifest.packages.find((p) => p.family === "migration");
    expect(migration.sourceSnapshot).not.toBeNull();
    expect(migration.sourceSnapshot.sha256).toMatch(SHA256);
    // Codex P1 fix: the package manifest's sourceSnapshot uses plain
    // ArtifactFileRefSchema (no artifactType). The brief's sourceSnapshotRef
    // carries artifactType, but the manifest does not — it's a strict schema.
    expect(migration.sourceSnapshot.artifactType).toBeUndefined();
    expect(migration.sourceSnapshot.path).toMatch(
      /^eval\/c2\/pilot\/source-snapshots\//,
    );

    for (const pkg of manifest.packages) {
      if (pkg.family !== "migration") {
        expect(pkg.sourceSnapshot).toBeNull();
      }
    }
  });

  it("fails when a brief and label disagree on caseVersion", async () => {
    const dest = copyPilotIntoTemp("c2-pilot-cv-");
    try {
      const labelPath = join(dest, "eval/c2/pilot/labels/stablecoin-home.json");
      const label = readJson(labelPath);
      label.caseVersion = 99; // brief still says 1
      writeJson(labelPath, label);

      await expect(buildPilotManifest(dest)).rejects.toThrow(/caseVersion mismatch/);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("check mode reports stale bytes without rewriting", async () => {
    const dest = copyPilotIntoTemp("c2-pilot-stale-");
    try {
      const manifestPath = join(dest, "eval/c2/pilot/manifest.json");
      // Write a plausible-but-stale manifest: right shape, wrong version stamp.
      const canonical = await buildPilotManifest(dest);
      writeJson(manifestPath, { ...canonical, manifestVersion: 999 });

      await expect(checkPilotManifest(dest)).rejects.toThrow(/pilot manifest is stale/);

      // checkPilotManifest must NOT have rewritten the file.
      const after = readJson(manifestPath);
      expect(after.manifestVersion).toBe(999);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("check mode passes when the on-disk manifest is canonical", async () => {
    const dest = copyPilotIntoTemp("c2-pilot-fresh-");
    try {
      const manifestPath = join(dest, "eval/c2/pilot/manifest.json");
      const canonical = await buildPilotManifest(dest);
      writeJson(manifestPath, canonical);

      await expect(checkPilotManifest(dest)).resolves.toBeUndefined();
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("rejects symlinks, orphan labels, orphan snapshots", async () => {
    // ── Symlink: replace a brief file with a symlink to the real file ──────
    const symDest = copyPilotIntoTemp("c2-pilot-sym-");
    try {
      const briefPath = join(symDest, "eval/c2/pilot/briefs/stablecoin-home.json");
      rmSync(briefPath, { force: true });
      symlinkSync(join(PILOT_SRC, "briefs/stablecoin-home.json"), briefPath);

      await expect(buildPilotManifest(symDest)).rejects.toThrow(/symbolic link/);
    } finally {
      rmSync(symDest, { recursive: true, force: true });
    }

    // ── Orphan label: a label with no matching brief ──────────────────────
    const orphanLabelDest = copyPilotIntoTemp("c2-pilot-ol-");
    try {
      writeFileSync(
        join(orphanLabelDest, "eval/c2/pilot/labels/ghost-case.json"),
        `${JSON.stringify(
          {
            schemaVersion: "1.0",
            artifactType: "c2-decision-label",
            artifactId: "c2-label-ghost-case-v1",
            caseId: "ghost-case",
            caseVersion: 1,
            labelVersion: 1,
          },
          null,
          2,
        )}\n`,
      );

      await expect(buildPilotManifest(orphanLabelDest)).rejects.toThrow(/orphan label/);
    } finally {
      rmSync(orphanLabelDest, { recursive: true, force: true });
    }

    // ── Orphan snapshot: a snapshot with no matching migration brief ───────
    const orphanSnapDest = copyPilotIntoTemp("c2-pilot-os-");
    try {
      writeFileSync(
        join(orphanSnapDest, "eval/c2/pilot/source-snapshots/ghost-migration.json"),
        `${JSON.stringify(
          {
            schemaVersion: "1.0",
            artifactType: "design-source-snapshot",
            artifactId: "design-source-snapshot-ghost-migration-v1",
            projectId: "ghost-migration",
          },
          null,
          2,
        )}\n`,
      );

      await expect(buildPilotManifest(orphanSnapDest)).rejects.toThrow(/orphan snapshot/);
    } finally {
      rmSync(orphanSnapDest, { recursive: true, force: true });
    }
  });

  it("rejects a non-migration brief that binds a source snapshot", async () => {
    const dest = copyPilotIntoTemp("c2-pilot-stray-");
    try {
      const briefPath = join(dest, "eval/c2/pilot/briefs/stablecoin-home.json");
      const brief = readJson(briefPath);
      brief.sourceSnapshotRef = {
        artifactId: "design-source-snapshot-public-marketing-migration-v1",
        path: "eval/c2/pilot/source-snapshots/public-marketing-migration.json",
        sha256: "0".repeat(64),
        artifactType: "design-source-snapshot",
      };
      writeJson(briefPath, brief);

      await expect(buildPilotManifest(dest)).rejects.toThrow(
        /must not bind a source snapshot|non-migration/i,
      );
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
