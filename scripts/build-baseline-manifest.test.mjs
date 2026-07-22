import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveSourceSnapshot,
  validateSourceSnapshotFile,
} from "./build-baseline-manifest.mjs";

function snapshot(overrides = {}) {
  return {
    schemaVersion: "1.0",
    artifactType: "design-source-snapshot",
    artifactId: "design-source-snapshot-migration-test-v1",
    projectId: "migration-test",
    source: {
      kind: "user-supplied-public-reference",
      origin: "https://example.com",
      startingUrls: ["https://example.com/start"],
    },
    capturedAt: "2026-07-22T00:00:00.000Z",
    crawl: { maxRoutes: 1, sameOrigin: true, authenticated: false, mutationAllowed: false },
    coverage: [{
      url: "https://example.com/start",
      status: "inspected",
      reason: "baseline fixture",
      archetype: "landing",
      viewports: ["desktop"],
    }],
    foundations: {
      colors: [], typography: [], spacing: [], radii: [], shadows: [], layout: [],
    },
    components: [],
    responsiveFindings: [],
    accessibility: [],
    motion: [],
    voice: [],
    evidence: [],
    limitations: [],
    ...overrides,
  };
}

function writeSnapshot(doc) {
  const dir = mkdtempSync(join(tmpdir(), "c2-baseline-snapshot-"));
  const path = join(dir, "snapshot.json");
  const bytes = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function ref(sha256) {
  return {
    artifactId: "design-source-snapshot-migration-test-v1",
    path: "eval/c2/baseline/source-snapshots/migration-test.json",
    sha256,
  };
}

describe("baseline migration source snapshot validation", () => {
  it("accepts a regular schema-valid snapshot with matching bindings", () => {
    const file = writeSnapshot(snapshot());
    expect(() => validateSourceSnapshotFile(file.path, ref(file.sha256), "migration-test")).not.toThrow();
  });

  it("rejects a symbolic-link snapshot", () => {
    const file = writeSnapshot(snapshot());
    const link = join(mkdtempSync(join(tmpdir(), "c2-baseline-link-")), "snapshot.json");
    symlinkSync(file.path, link);
    expect(() => validateSourceSnapshotFile(link, ref(file.sha256), "migration-test")).toThrow(/symbolic link/i);
  });

  it("rejects a dangling symbolic link instead of treating it as a missing staged snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "c2-baseline-dangling-"));
    const relativePath = "source-snapshots/migration-test.json";
    const link = join(root, relativePath);
    mkdirSync(join(root, "source-snapshots"));
    symlinkSync(join(root, "missing-target.json"), link);
    const sourceRef = { ...ref("0".repeat(64)), path: relativePath, artifactType: "design-source-snapshot" };
    const brief = {
      name: "migration-test.json",
      parsed: {
        caseId: "migration-test",
        family: "migration",
        sourceSnapshotRef: sourceRef,
      },
    };

    expect(() => resolveSourceSnapshot(
      brief,
      { allowMissingSnapshots: true },
      root,
      [],
    )).toThrow(/symbolic link/i);
  });

  it("rejects a schema-invalid snapshot even when its hash matches", () => {
    const file = writeSnapshot({ artifactId: "design-source-snapshot-migration-test-v1" });
    expect(() => validateSourceSnapshotFile(file.path, ref(file.sha256), "migration-test")).toThrow(/schema/i);
  });

  it("rejects an internal artifactId that disagrees with the brief ref", () => {
    const file = writeSnapshot(snapshot({ artifactId: "design-source-snapshot-wrong-v1" }));
    expect(() => validateSourceSnapshotFile(file.path, ref(file.sha256), "migration-test")).toThrow(/artifactId/i);
  });

  it("rejects an internal projectId that disagrees with the brief caseId", () => {
    const file = writeSnapshot(snapshot({ projectId: "wrong-case" }));
    expect(() => validateSourceSnapshotFile(file.path, ref(file.sha256), "migration-test")).toThrow(/projectId/i);
  });
});
