import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "audit-corpus-coverage.mjs");

function fixtureCorpus(colorRoles, layout) {
  const root = mkdtempSync(join(tmpdir(), "audit-corpus-"));
  // The audit floors are ABSOLUTE counts (colorRoles >= 600, layout >= 600),
  // so the fixture must exceed the floor for the pass case; 600 entries with
  // full coverage lands exactly on the floor.
  const entries = Array.from({ length: 600 }, (_, i) => ({
    id: `entry-${i}`,
    patternType: "dashboard",
    visual: {
      dominantColors: ["#000000"],
      accentColor: "#2563eb",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "compact",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
      colorRoles: colorRoles ? {
        canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
      } : undefined,
    },
    layout: layout ? { form: "two-column", regions: [{ role: "main-canvas" }] } : undefined,
  }));
  const path = join(root, "entries.json");
  writeFileSync(path, JSON.stringify({ version: "1", entries }));
  return { root, path };
}

test("audit passes when floors hold", () => {
  const { root, path } = fixtureCorpus(true, true);
  try {
    const out = execFileSync("node", [SCRIPT, path], { encoding: "utf8" });
    expect(out).toContain("colorRoles");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit fails when colorRoles coverage drops below the floor", () => {
  const { root, path } = fixtureCorpus(false, true);
  try {
    expect(() => execFileSync("node", [SCRIPT, path], { encoding: "utf8" })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
