import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(repoRoot, "eval/c2/label-integrity/packet/validate-reviewer-file.mjs");
const selectionPath = path.join(repoRoot, "eval/c2/label-integrity/selection.json");
const selectionBytes = fs.readFileSync(selectionPath);
const selection = JSON.parse(selectionBytes);
const selectionSha256 = crypto.createHash("sha256").update(selectionBytes).digest("hex");
const tempDirs = [];

function makeLabels() {
  return selection.entries.map(({ entryId }) => ({
    entryId,
    patternType: "dashboard",
    categories: ["dashboard"],
    components: ["top-nav"],
    domainTags: ["analytics"],
    visualFields: {
      density: "moderate",
      "color-scheme": "light",
      typography: "neutral sans",
      layout: "single-column",
    },
    groundedClaimIds: ["claim:visual-inspection"],
    accessibilityEvidenceIds: [],
    critiqueQuality: "acceptable",
    protectedFieldExpectation: "unchanged",
  }));
}

function writeFixture(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-reviewer-validator-"));
  tempDirs.push(dir);
  const file = path.join(dir, "submission.json");
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function runValidator(inputPath) {
  return execFileSync(process.execPath, [validator, inputPath, "--strict"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("validate-reviewer-file strict mode", () => {
  it("accepts a complete production submission without packet-only metadata", () => {
    const inputPath = writeFixture({
      schemaVersion: "1.0",
      artifactType: "c2-independent-label-submission",
      artifactId: "c2-independent-label-submission-test-v1",
      selectionArtifactId: selection.artifactId,
      selectionSha256,
      submissionVersion: 1,
      actorId: "test-human-reviewer",
      actorKind: "human",
      reviewerRole: "Gold Label Owner",
      sealedAt: "2026-07-26T00:00:00.000Z",
      labels: makeLabels(),
    });

    expect(runValidator(inputPath)).toContain("OK — 40 labels");
  });

  it("rejects a browser packet export instead of treating labels as a submission", () => {
    const inputPath = writeFixture({
      labelingMethod: "human",
      parentAuthority: "<FILL>",
      provenanceDoc: "<FILL>",
      reviewer: "packet-reviewer",
      selectionArtifactId: selection.artifactId,
      selectionSha256,
      labels: makeLabels(),
    });

    expect(() => runValidator(inputPath)).toThrow(/Unrecognized keys|MISSING/);
  });
});
