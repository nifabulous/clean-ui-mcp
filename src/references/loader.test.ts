import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { selectReferences, validateReferenceRegistry } from "./loader.js";
import type { ReferenceDescriptor } from "./types.js";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

function descriptor(id: string, path: string, content: string): ReferenceDescriptor {
  return {
    id,
    version: 1,
    path,
    sha256: sha256(content),
    authority: id === "material-design-3" ? "external-standard" : "editorial",
    purposes: id === "design-engineering" ? ["motion-guidance"] : ["critique-structure"],
    sourceUrl: `https://example.com/${id}`,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    license: "MIT",
  };
}

function fixture(): { root: string; descriptors: ReferenceDescriptor[] } {
  const root = mkdtempSync(join(tmpdir(), "reference-registry-"));
  const referenceDir = join(root, "skill/clean-ui-design/references");
  mkdirSync(referenceDir, { recursive: true });
  const descriptors = [
    descriptor("banned-phrases", "skill/clean-ui-design/references/banned-phrases.md", "banned"),
    descriptor("decision-effect-rejection", "skill/clean-ui-design/references/decision-effect-rejection.md", "decision"),
    descriptor("design-engineering", "skill/clean-ui-design/references/design-engineering.md", "motion"),
    descriptor("material-design-3", "skill/clean-ui-design/references/material-design-3.md", "material"),
  ];
  for (const item of descriptors) writeFileSync(join(root, item.path), item.id === "banned-phrases" ? "banned" : item.id === "decision-effect-rejection" ? "decision" : item.id === "design-engineering" ? "motion" : "material");
  writeFileSync(join(referenceDir, "manifest.json"), JSON.stringify(descriptors));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, descriptors };
}

function writeManifest(root: string, descriptors: ReferenceDescriptor[]): void {
  writeFileSync(join(root, "skill/clean-ui-design/references/manifest.json"), JSON.stringify(descriptors));
}

describe("validateReferenceRegistry", () => {
  it("loads and freezes four valid descriptors", () => {
    const { root } = fixture();
    const loaded = validateReferenceRegistry(root);
    expect(loaded.map((item) => item.id)).toEqual([
      "banned-phrases", "decision-effect-rejection", "design-engineering", "material-design-3",
    ]);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(loaded.every((item) => Object.isFrozen(item) && Object.isFrozen(item.purposes))).toBe(true);
  });

  it.each([["id"], ["path"]] as const)("rejects duplicate %ss", (field) => {
    const { root, descriptors } = fixture();
    descriptors[1] = { ...descriptors[1], [field]: descriptors[0][field] };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(new RegExp(`${descriptors[1].id}.*${field}`, "i"));
  });

  it("rejects traversal paths", () => {
    const { root, descriptors } = fixture();
    descriptors[0] = { ...descriptors[0], path: "skill/clean-ui-design/references/../../../secret.md" };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(/banned-phrases.*path/i);
  });

  it("rejects absolute paths", () => {
    const { root, descriptors } = fixture();
    descriptors[0] = { ...descriptors[0], path: "/tmp/reference.md" };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(/banned-phrases.*path/i);
  });

  it("rejects symlinks whose targets escape the repository root", () => {
    const { root, descriptors } = fixture();
    const externalRoot = mkdtempSync(join(tmpdir(), "external-reference-"));
    const externalPath = join(externalRoot, "reference.md");
    writeFileSync(externalPath, "external");
    const linkedPath = "skill/clean-ui-design/references/linked.md";
    symlinkSync(externalPath, join(root, linkedPath));
    descriptors[0] = { ...descriptors[0], path: linkedPath, sha256: sha256("external") };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(/banned-phrases.*path/i);
  });

  it("rejects missing files", () => {
    const { root, descriptors } = fixture();
    descriptors[0] = { ...descriptors[0], path: "skill/clean-ui-design/references/missing.md" };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(/banned-phrases.*path/i);
  });

  it("rejects an incorrect content hash", () => {
    const { root, descriptors } = fixture();
    descriptors[3] = { ...descriptors[3], sha256: "0".repeat(64) };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(/material-design-3.*sha256/i);
  });

  it("rejects a malformed source commit", () => {
    const { root, descriptors } = fixture();
    descriptors[2] = { ...descriptors[2], sourceCommit: "not-a-sha" };
    writeManifest(root, descriptors);
    expect(() => validateReferenceRegistry(root)).toThrow(/design-engineering.*sourceCommit/i);
  });

  it("enforces version increments when content hashes change", () => {
    const { root, descriptors } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "first"], { cwd: root });
    writeFileSync(join(root, descriptors[0].path), "changed");
    descriptors[0] = { ...descriptors[0], sha256: sha256("changed") };
    writeManifest(root, descriptors);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second"], { cwd: root });
    expect(() => validateReferenceRegistry(root)).toThrow(/banned-phrases.*version/i);
  });

  it("rejects version changes when the content hash is unchanged", () => {
    const { root, descriptors } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "first"], { cwd: root });
    descriptors[0] = { ...descriptors[0], version: 2 };
    writeManifest(root, descriptors);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second"], { cwd: root });
    expect(() => validateReferenceRegistry(root)).toThrow(/banned-phrases.*version/i);
  });

  it("does not hide a malformed previous manifest", () => {
    const { root, descriptors } = fixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "skill/clean-ui-design/references/manifest.json"), "not json");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "first"], { cwd: root });
    writeManifest(root, descriptors);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second"], { cwd: root });
    expect(() => validateReferenceRegistry(root)).toThrow(/HEAD\^.*invalid JSON/i);
  });

  it("does not hide a missing Git repository", () => {
    const { root } = fixture();
    const withoutGit = mkdtempSync(join(tmpdir(), "reference-registry-no-git-"));
    execFileSync("cp", ["-R", `${root}/skill`, withoutGit]);
    expect(() => validateReferenceRegistry(withoutGit)).toThrow(/previous reference manifest.*not a git repository/i);
  });
});

describe("selectReferences", () => {
  it("returns matching references in registry order", () => {
    const { descriptors } = fixture();
    expect(selectReferences(descriptors, ["motion-guidance"]).map((item) => item.id))
      .toEqual(["design-engineering"]);
  });
});
