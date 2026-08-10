import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function runCli(args: string[]) {
  return spawnSync("npm", ["run", "color-scheme-audit", "--", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
}

describe("color scheme audit CLI", () => {
  it("runs the documented command and enforces private immutable output", async () => {
    const root = mkdtempSync(join(tmpdir(), "clean-ui-color-audit-cli-"));
    const corpusRoot = join(root, "corpus");
    mkdirSync(join(corpusRoot, "images-private"), { recursive: true });
    const imagePath = join(corpusRoot, "images-private", "one.png");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 245, g: 245, b: 245 } } }).png().toFile(imagePath);
    const corpusPath = join(corpusRoot, "entries.json");
    writeFileSync(corpusPath, JSON.stringify({ entries: [{ id: "one", image: { path: "images-private/one.png" }, colorScheme: null }] }));
    const reportPath = join(root, "report.json");

    const success = runCli(["--corpus", corpusPath, "--out", reportPath]);
    expect(success.status, success.stderr).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { summary: { entries: number }; detector: { maxDimension: number } };
    expect(report.summary.entries).toBe(1);
    expect(report.detector.maxDimension).toBe(256);

    const inside = runCli(["--corpus", corpusPath, "--out", join(corpusRoot, "report.json")]);
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toMatch(/outside the corpus directory/);

    const existing = runCli(["--corpus", corpusPath, "--out", reportPath]);
    expect(existing.status).not.toBe(0);
    expect(existing.stderr).toMatch(/EEXIST|already exists|file exists/i);
  }, 120_000);
});
