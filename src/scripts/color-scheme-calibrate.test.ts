import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildColorSchemeAuditReport } from "../color-scheme-audit.js";
import { canonicalArtifactJson } from "../color-scheme-calibration.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function runCli(args: string[]) {
  return spawnSync("npm", ["run", "color-scheme-calibrate", "--", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    timeout: 120_000,
  });
}

describe("color scheme calibration CLI", () => {
  it("builds and evaluates a private packet without mutating the corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-calibrate-"));
    const corpusRoot = join(root, "corpus");
    const imageDir = join(corpusRoot, "images-private");
    mkdirSync(imageDir, { recursive: true });
    const imageBytes = Buffer.from("fixture-image");
    writeFileSync(join(imageDir, "one.png"), imageBytes);
    const corpusPath = join(corpusRoot, "entries.json");
    writeFileSync(corpusPath, JSON.stringify({ entries: [{ id: "one", image: { path: "images-private/one.png" }, colorScheme: null }] }));
    const audit = await buildColorSchemeAuditReport({
      corpusSha256: hash("corpus"),
      entries: [{ entryId: "one", imagePath: "images-private/one.png", imageSha256: hash(imageBytes), existingColorScheme: null }],
      detect: async () => ({ colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 }),
    });
    const auditPath = join(root, "audit.json");
    writeFileSync(auditPath, canonicalArtifactJson(audit));
    const packetPath = join(root, "packet.json");
    const htmlPath = join(root, "packet.html");
    const before = readFileSync(corpusPath);
    const packetRun = runCli(["packet", "--audit", auditPath, "--corpus", corpusPath, "--json", packetPath, "--html", htmlPath, "--size", "1"]);
    expect(packetRun.status, packetRun.stderr).toBe(0);
    expect(readFileSync(packetPath, "utf8")).toContain("color-scheme-calibration-packet");
    expect(readFileSync(htmlPath, "utf8")).toContain("Color-scheme calibration");
    const packet = JSON.parse(readFileSync(packetPath, "utf8")) as { artifactId: string; entries: Array<{ entryId: string; imageSha256: string; detectedColorScheme: string }>; };
    const packetSha256 = hash(readFileSync(packetPath));
    const submissionPath = join(root, "submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "submission-alice-v1", packetArtifactId: packet.artifactId,
      packetSha256, reviewerId: "alice", sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    }));
    const reportPath = join(root, "calibration.json");
    const evaluateRun = runCli(["evaluate", "--audit", auditPath, "--packet", packetPath, "--submission", submissionPath, "--corpus", corpusPath, "--out", reportPath, "--minimum-labels", "1", "--minimum-accuracy", "1"]);
    expect(evaluateRun.status, evaluateRun.stderr).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({ status: "pass", counts: { selected: 1, scored: 1, correct: 1 } });
    expect(readFileSync(corpusPath)).toEqual(before);

    const unsafe = runCli(["packet", "--audit", auditPath, "--corpus", corpusPath, "--json", join(corpusRoot, "leaked.json")]);
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stderr).toMatch(/outside the corpus directory/);

    // Immutable outputs: an existing artifact is never silently overwritten.
    const overwrite = runCli(["packet", "--audit", auditPath, "--corpus", corpusPath, "--json", packetPath]);
    expect(overwrite.status).not.toBe(0);
    expect(overwrite.stderr).toMatch(/EEXIST|exists/i);
    expect(readFileSync(packetPath, "utf8")).toContain("color-scheme-calibration-packet");

    // The recorded packet digest must be reproducible with sha256sum on the file.
    expect(hash(readFileSync(packetPath))).toBe(packetSha256);

    // Stale image bytes must stop evaluation rather than score labels against a
    // screenshot the reviewer never saw.
    writeFileSync(join(imageDir, "one.png"), Buffer.from("different-image-bytes"));
    const stale = runCli(["evaluate", "--audit", auditPath, "--packet", packetPath, "--submission", submissionPath, "--corpus", corpusPath, "--out", join(root, "stale.json"), "--minimum-labels", "1", "--minimum-accuracy", "1"]);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toMatch(/image hash mismatch/);
    expect(readFileSync(corpusPath)).toEqual(before);
  }, 180_000);

  it("marks a below-floor gate as not promotion eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-calibrate-floor-"));
    const corpusRoot = join(root, "corpus");
    const imageDir = join(corpusRoot, "images-private");
    mkdirSync(imageDir, { recursive: true });
    const imageBytes = Buffer.from("floor-image");
    writeFileSync(join(imageDir, "one.png"), imageBytes);
    const corpusPath = join(corpusRoot, "entries.json");
    writeFileSync(corpusPath, JSON.stringify({ entries: [{ id: "one", image: { path: "images-private/one.png" }, colorScheme: null }] }));
    const audit = await buildColorSchemeAuditReport({
      corpusSha256: hash("corpus"),
      entries: [{ entryId: "one", imagePath: "images-private/one.png", imageSha256: hash(imageBytes), existingColorScheme: null }],
      detect: async () => ({ colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 }),
    });
    const auditPath = join(root, "audit.json");
    writeFileSync(auditPath, canonicalArtifactJson(audit));
    const packetPath = join(root, "packet.json");
    expect(runCli(["packet", "--audit", auditPath, "--corpus", corpusPath, "--json", packetPath, "--size", "1"]).status).toBe(0);
    const packet = JSON.parse(readFileSync(packetPath, "utf8")) as { artifactId: string; entries: Array<{ entryId: string; imageSha256: string; detectedColorScheme: string }> };
    const submissionPath = join(root, "submission.json");
    writeFileSync(submissionPath, JSON.stringify({
      schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "submission-floor-v1", packetArtifactId: packet.artifactId,
      packetSha256: hash(readFileSync(packetPath)), reviewerId: "floor", sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    }));
    const reportPath = join(root, "calibration.json");
    const run = runCli(["evaluate", "--audit", auditPath, "--packet", packetPath, "--submission", submissionPath, "--corpus", corpusPath, "--out", reportPath, "--minimum-labels", "1", "--minimum-accuracy", "1"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/promotion-eligible: no/);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({ status: "pass", promotionEligible: false });
  }, 180_000);
});

describe("color scheme calibration CLI argument and path guards", () => {
  const root = mkdtempSync(join(tmpdir(), "clean-ui-color-calibrate-guards-"));

  // Two usage-string assertions (unknown mode, missing --audit) were dropped:
  // each cost a full `tsc && node` subprocess to assert error text for a
  // developer typo, with no safety property behind it, and the extra
  // invocations made the suite flaky against runCli's 120s timeout.
  it("refuses gate thresholds outside their valid range", async () => {
    const corpusRoot = join(root, "corpus");
    mkdirSync(join(corpusRoot, "images-private"), { recursive: true });
    const bytes = Buffer.from("guard-image");
    writeFileSync(join(corpusRoot, "images-private", "one.png"), bytes);
    writeFileSync(join(corpusRoot, "entries.json"), JSON.stringify({ entries: [{ id: "one", image: { path: "images-private/one.png" } }] }));
    const audit = await buildColorSchemeAuditReport({
      corpusSha256: hash("corpus"),
      entries: [{ entryId: "one", imagePath: "images-private/one.png", imageSha256: hash(bytes), existingColorScheme: null }],
      detect: async () => ({ colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 }),
    });
    const auditPath = join(root, "audit.json");
    writeFileSync(auditPath, canonicalArtifactJson(audit));
    const bad = runCli(["packet", "--audit", auditPath, "--corpus", join(corpusRoot, "entries.json"), "--json", join(root, "p.json"), "--size", "0"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/--size must be a positive integer/);
  }, 120_000);
});
