/**
 * C2 private-artifacts tests (Task 6, Step 1 + Step 6).
 *
 * The boundary between durable, committable C2 artifacts (deterministic scores,
 * calibration proposals, frozen calibration) and the private run directory is
 * enforced by a scanner that rejects durable JSON containing:
 *   - configured secret values (env-var values, API keys),
 *   - prompt/evidence/raw content fields,
 *   - `.c2-private/` paths,
 *   - corpus private paths (`images-private/`, `corpus/.snapshots`, etc.),
 *   - case private markers.
 *
 * Private writes are atomic: write → fsync → close → rename, with full cleanup
 * on any failure. This test exercises the scanner directly AND the atomic-write
 * lifecycle against a temp directory.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanDurableArtifact,
  writePrivateArtifact,
  writeDurableArtifact,
  type BoundaryScanConfig,
} from "./private-artifacts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// scanDurableArtifact
// ---------------------------------------------------------------------------

describe("scanDurableArtifact", () => {
  const baseConfig: BoundaryScanConfig = {
    secretValues: ["sk-test-secret-123", "voyage-abc"],
    secretEnvNames: ["OPENAI_API_KEY", "VOYAGE_API_KEY"],
  };

  it("accepts an artifact with only hashes and metadata", () => {
    const artifact = {
      schemaVersion: "1.0",
      artifactType: "c2-deterministic-score",
      artifactId: "score-1",
      runId: "run-1",
      runOutputSha256: "a".repeat(64),
      scorerSha256: "b".repeat(64),
      complete: true,
      requiredSectionCoverage: 1,
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).not.toThrow();
  });

  it("rejects an artifact containing a configured secret value", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      note: "ran with key sk-test-secret-123",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/secret/i);
  });

  it("rejects an artifact containing prompt content fields", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      prompt: "### SYSTEM INSTRUCTION ###",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/prompt/i);
  });

  it("rejects an artifact containing evidence content fields", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      evidenceContent: "hero headline stack",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/evidence/i);
  });

  it("rejects an artifact containing raw response content fields", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      rawResponse: '{"output":"..."}',
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/raw/i);
  });

  it("rejects an artifact containing a .c2-private path", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      path: ".c2-private/runs/run-1/output.json",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/private/i);
  });

  it("rejects an artifact containing a corpus private path (images-private)", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      ref: "corpus/images-private/secret.png",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/private|corpus/i);
  });

  it("rejects an artifact containing a case private marker", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      marker: "/corpus/private/case/secret",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/private/i);
  });

  it("rejects an artifact containing an env-var value that matches a configured secret", () => {
    const artifact = {
      artifactType: "c2-deterministic-score",
      note: "Authorization: Bearer voyage-abc",
    };
    expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).toThrow(/secret/i);
  });
});

// ---------------------------------------------------------------------------
// writePrivateArtifact — atomic write lifecycle
// ---------------------------------------------------------------------------

describe("writePrivateArtifact", () => {
  let privateRoot: string;

  beforeEach(() => {
    privateRoot = mkdtempSync(join(tmpdir(), "c2-private-artifacts-"));
  });
  afterEach(() => {
    try { rmSync(privateRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("atomically writes the payload to the resolved path", async () => {
    const relPath = "runs/run-1/raw-response.json";
    const payload = Buffer.from(JSON.stringify({ content: "abc" }));
    const abs = await writePrivateArtifact(privateRoot, relPath, payload);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf-8")).toBe(JSON.stringify({ content: "abc" }));
    // No leftover temp file litters the directory after the rename.
    const parent = dirname(abs);
    expect(readdirSync(parent).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("creates nested directories as needed", async () => {
    const relPath = "deep/nested/path/file.json";
    const abs = await writePrivateArtifact(privateRoot, relPath, Buffer.from("x"));
    expect(existsSync(abs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeDurableArtifact — boundary-gated atomic write
// ---------------------------------------------------------------------------

describe("writeDurableArtifact", () => {
  let destRoot: string;

  beforeEach(() => {
    destRoot = mkdtempSync(join(tmpdir(), "c2-durable-"));
  });
  afterEach(() => {
    try { rmSync(destRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes a clean durable artifact", async () => {
    const artifact = JSON.stringify({
      artifactType: "c2-deterministic-score",
      runOutputSha256: "a".repeat(64),
    });
    const abs = await writeDurableArtifact(destRoot, "scores/run-1.json", artifact, {
      secretValues: [],
      secretEnvNames: [],
    });
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf-8")).toBe(artifact);
  });

  it("refuses to write a durable artifact that fails the boundary scan", async () => {
    const artifact = JSON.stringify({
      artifactType: "c2-deterministic-score",
      prompt: "leaked prompt",
    });
    await expect(
      writeDurableArtifact(destRoot, "scores/run-1.json", artifact, {
        secretValues: [],
        secretEnvNames: [],
      }),
    ).rejects.toThrow(/prompt|boundary/i);
    expect(existsSync(join(destRoot, "scores/run-1.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// .c2-private gitignore coverage
// ---------------------------------------------------------------------------

describe(".c2-private gitignore", () => {
  it("git check-ignore confirms .c2-private/ is ignored", () => {
    // Drop a probe file and assert git would ignore it. This guards the
    // private-boundary promise: a future `.c2-private/` artifact never lands
    // in a commit by accident.
    const probeDir = join(REPO_ROOT, ".c2-private");
    const probe = join(probeDir, "probe");
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(probe, "probe", { flag: "w" });
    try {
      const result = execSync("git check-ignore .c2-private/probe", {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(result.trim()).toBe(".c2-private/probe");
    } finally {
      try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
