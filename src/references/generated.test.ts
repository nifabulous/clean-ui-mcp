import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BANNED_PHRASES,
  EXEMPTION_PATTERNS,
  PIXEL_MEASUREMENT,
  UNLABELED_CONTROL_RISK,
  VAGUE_PHRASES,
} from "./generated.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const generatorPath = fileURLToPath(new URL("../../scripts/generate-reference-artifacts.mjs", import.meta.url));
const generatedPath = fileURLToPath(new URL("./generated.ts", import.meta.url));
const rulesPath = fileURLToPath(new URL("../../skill/clean-ui-design/references/machine-rules.json", import.meta.url));
const markdownPath = fileURLToPath(new URL("../../skill/clean-ui-design/references/banned-phrases.md", import.meta.url));
const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));

function runGenerator(args: string[] = [], environment: NodeJS.ProcessEnv = {}): void {
  execFileSync(process.execPath, [generatorPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: "pipe",
  });
}

function markdownPhrases(heading: string): string[] {
  const markdown = readFileSync(markdownPath, "utf8");
  const section = markdown.split(`## ${heading}\n`, 2)[1]?.split("\n## ", 1)[0];
  if (!section) throw new Error(`Missing Markdown section: ${heading}`);
  return [...section.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

describe("generated machine rules", () => {
  it("has a valid canonical JSON schema and compilable patterns", () => {
    expect(() => JSON.parse(readFileSync(rulesPath, "utf8"))).not.toThrow();
    expect(BANNED_PHRASES).toContain("clean layout");
    expect(VAGUE_PHRASES).toContain("keep it clean");
    expect(UNLABELED_CONTROL_RISK.test("icon-only button without a label")).toBe(true);
    expect(PIXEL_MEASUREMENT.test("a 12px radius")).toBe(true);
    expect(EXEMPTION_PATTERNS.domGroundTruth.test("measured via DOM")).toBe(true);
  });

  it("matches the Markdown phrase lists exactly", () => {
    expect([...BANNED_PHRASES]).toEqual(markdownPhrases("Banned phrases"));
    expect([...VAGUE_PHRASES]).toEqual(markdownPhrases("Vague phrases"));
  });

  it("generates deterministic output", () => {
    const before = readFileSync(generatedPath, "utf8");
    runGenerator();
    expect(readFileSync(generatedPath, "utf8")).toBe(before);
  });

  it("passes --check on the clean committed state (no drift)", () => {
    // This catches the case where someone edits machine-rules.json and commits
    // without regenerating generated.ts. If this test fails, run:
    //   npm run generate-references
    expect(() => runGenerator(["--check"])).not.toThrow();
  });

  it("fails --check when the generated file drifts", () => {
    const original = readFileSync(generatedPath, "utf8");
    try {
      writeFileSync(generatedPath, `${original}// drift\n`);
      expect(() => runGenerator(["--check"])).toThrow();
    } finally {
      writeFileSync(generatedPath, original);
    }
  });

  it("rejects invalid schema and regex definitions before generating", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "clean-ui-rules-"));
    const invalidRulesPath = join(temporaryDirectory, "machine-rules.json");
    try {
      const invalidRules = JSON.parse(readFileSync(rulesPath, "utf8")) as Record<string, unknown>;
      const patterns = invalidRules.patterns as Record<string, unknown>;
      invalidRules.patterns = {
        ...patterns,
        pixelMeasurement: { source: "[", flags: "i" },
      };
      writeFileSync(invalidRulesPath, JSON.stringify(invalidRules));
      expect(() => runGenerator([], { MACHINE_RULES_PATH: invalidRulesPath })).toThrow();
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps registry validation in the reference-validation command", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["validate-references"]).toContain("dist/references/loader.js");
  });
});
