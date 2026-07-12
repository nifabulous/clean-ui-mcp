/**
 * wiring-verification.test.ts — catch "built but not wired" dead code.
 *
 * This test mechanically verifies that every exported function/const/class in
 * src/*.ts (excluding scripts, fixtures, and type-only exports) is referenced
 * by at least one non-test production file. It catches the recurring failure
 * mode where a module is created and unit-tested in isolation but never
 * connected to production code.
 *
 * Known limitations (documented):
 * - Interface/call-site drift (new optional param not passed by caller) — needs ts-morph
 * - Semantic correctness of wiring — still needs review agents
 * - Dynamic imports without destructured names — rare; current codebase always destructures
 * - Type-only exports (export type, export interface) — out of scope
 * - Comment/string defeat: a symbol name appearing in a comment or string literal
 *   in any production file satisfies the check. This is a known heuristic limitation;
 *   do not rely on comments to "wire" a symbol.
 *
 * This test follows the proven pattern from content-lint.test.ts (readFileSync +
 * regex assertions), avoiding shell-grep portability issues.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(__dirname);

// ─── collect all non-test production TS files ─────────────────────────────────
// EXTRACT from: src/*.ts excluding scripts, fixtures (don't flag their exports)
// SCAN in: all src/*.ts excluding test files (scripts ARE legitimate consumers)

const EXTRACT_EXCLUDE_DIRS = new Set(["scripts", "__fixtures__"]);

function collectAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectAllTsFiles(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

function collectExtractableTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!EXTRACT_EXCLUDE_DIRS.has(entry)) {
        results.push(...collectExtractableTsFiles(fullPath));
      }
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

// All non-test TS files — used for reference scanning (includes scripts as consumers)
const ALL_TS_FILES = collectAllTsFiles(SRC_DIR);
// Files we extract exports from — excludes scripts (their exports are wiring-complete by definition)
const EXTRACT_FILES = collectExtractableTsFiles(SRC_DIR);

// ─── extract exported symbols from a source file ──────────────────────────────

const EXPORT_RE = /\bexport\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
// Also catch re-exports: export { Foo, Bar } from "..."
const RE_EXPORT_RE = /\bexport\s*\{([^}]+)\}\s*(?:from\s+["'][^"']+["'])?/g;

interface ExportedSymbol {
  name: string;
  file: string;
}

function extractExports(filePath: string): ExportedSymbol[] {
  const source = readFileSync(filePath, "utf8");
  const symbols: ExportedSymbol[] = [];

  // export function/const/class NAME
  for (const match of source.matchAll(EXPORT_RE)) {
    symbols.push({ name: match[1], file: filePath });
  }

  // export { Foo, Bar } from "..."
  for (const match of source.matchAll(RE_EXPORT_RE)) {
    const names = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (name && /^[A-Za-z_$]/.test(name)) {
        symbols.push({ name, file: filePath });
      }
    }
  }

  return symbols;
}

// ─── check if a symbol is referenced in any production file ───────────────────

function isReferencedInProduction(symbolName: string, definingFile: string): boolean {
  for (const file of ALL_TS_FILES) {
    // Include the defining file in the scan — many exported functions are called
    // within their own module (e.g. internal helpers in tagger.ts). If the symbol
    // is referenced anywhere in src/*.ts including its own file (beyond the
    // export declaration line), it's wired.
    const source = readFileSync(file, "utf8");
    // Check for the symbol name as a word boundary match
    const re = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const matches = source.match(re) || [];
    if (file === definingFile) {
      // For the defining file, we need at least 2 references: the export declaration
      // itself counts as 1, so a second reference means it's called/used within the file.
      if (matches.length >= 2) return true;
    } else {
      if (matches.length >= 1) return true;
    }
  }
  return false;
}

// ─── collect all exported symbols across extractable files ────────────────────

const allExports: ExportedSymbol[] = [];
for (const file of EXTRACT_FILES) {
  allExports.push(...extractExports(file));
}

// ─── allowlist: symbols consumed by .mjs scripts, test utilities, or external callers ─
const ALLOWLIST = new Set<string>([
  // Consumed by .mjs scripts via dist/ imports (not visible in src/*.ts grep):
  "MIN_WORDS",                 // content-lint.ts — used by eval-scorer.mjs
  "MAX_IMAGE_BYTES",           // critique-ui.ts — used by eval test
  "setDecisionsPathsForTesting", // decisions.ts — test-only export
  "resetDecisionsPathsForTesting", // decisions.ts — test-only export
  "setDecisionsForTesting",    // decisions.ts — test-only export
  "persistDHashCache",         // dedup.ts — used by dedup-cleanup.ts script
  "EMBED_DIM",                 // embeddings.ts — used by build-index.mjs
  "INDEX_PATH",                // embeddings.ts — used by build-index.mjs
  "DEFAULT_ENV_PATH",          // env.ts — used by .mjs scripts
  "DEFAULT_OPENAI_AUTO_TAG_MODEL", // env.ts — used by .mjs scripts
  "DEFAULT_CLEAN_UI_PORT",     // env.ts — used by .mjs scripts
  "loadEnv",                   // env.ts — used by .mjs scripts
  "setImageIndexForTesting",   // image-index.ts — test-only export
  "assertCorpusImagePath",     // paths.ts — used by scripts
  "validateReferenceRegistry", // references/loader.ts — called internally at loader.ts:131
  "accessibilityRiskTextFields", // schema.ts — used by content-lint test
  "PatternDiscovery",          // schema.ts — Zod schema, used by scripts
  "AccessibilityRisk",         // schema.ts — Zod schema, used by schema validation
  "LayoutRegion",              // schema.ts — Zod schema, consumed by schema.parse
  "LayoutStructure",           // schema.ts — Zod schema
  "BusinessRationale",         // schema.ts — Zod schema
  "renderBriefTokens",         // design-prompt.ts — used by generate_design_prompt tool
  "renderDecisionBrief",       // decision-lab.ts — used by decision-lab UI
  "pickDiverse",               // recommend.ts — used by recommend_ui_direction
  "registerVisualEvidence",    // synthesis/context.ts — exported for test use, called by buildSynthesisContext
  // Zod schema consts — consumed by Zod composition (.extend, .parse) not by name reference:
  "ImageRef", "SourceAttribution", "TypePairing", "ColorRoles", "VisualAttributes",
  "DecisionScope", "DecisionStatus", "ScreenSource", "EvidenceCoverage", "DecisionContext",
  "RubricDimension", "RubricScore", "Perspective", "ExperimentBrief", "Tradeoff",
  "entryTextFields",
  "ClaimBasis", "VisualSlopBasis",
  "VisualSlopFinding", "MotionGuidance", "StructuredRecommendation",
  "StructuredAccessibilityRisk", "AppliedReference",
  // normalizeMotionDeclarations — DEFERRED: Task 8 Step 4 (browser-side Playwright
  // collection) hasn't landed yet. The pure function is ready but has no caller until
  // the capture pipeline collects transition/animation CSS. Remove from allowlist when wired.
  "normalizeMotionDeclarations",
]);

// ─── the test ─────────────────────────────────────────────────────────────────

describe("wiring verification — no orphaned exports", () => {
  it("every exported function/const/class is referenced by at least one non-test production file", () => {
    const orphans: Array<{ name: string; file: string }> = [];

    for (const sym of allExports) {
      if (ALLOWLIST.has(sym.name)) continue;
      if (!isReferencedInProduction(sym.name, sym.file)) {
        orphans.push(sym);
      }
    }

    if (orphans.length > 0) {
      const lines = orphans.map(
        (o) => `  • "${o.name}" in ${relative(__dirname, o.file)} — not referenced by any production file`,
      );
      // Provide a helpful remediation message
      const help = [
        "",
        "  If this symbol is consumed by an external caller (.mjs script, MCP client,",
        "  barrel re-export), add it to the ALLOWLIST in wiring-verification.test.ts",
        "  with a comment explaining why.",
        "",
        "  If it's genuinely unwired, either wire it to a production caller or delete it.",
      ];
      throw new Error(
        `Found ${orphans.length} orphaned export(s):\n${lines.join("\n")}\n${help.join("\n")}`,
      );
    }

    // Sanity: verify we actually checked a meaningful number of exports
    expect(allExports.length).toBeGreaterThan(50);
  });
});
