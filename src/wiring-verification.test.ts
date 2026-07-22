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
  "registerVisualEvidence",    // synthesis/context.ts — exported for test use, called by buildSynthesisContext
  // Zod schema consts — consumed by Zod composition (.extend, .parse) not by name reference:
  "ImageRef", "SourceAttribution", "TypePairing", "ColorRoles", "VisualAttributes",
  "DecisionScope", "DecisionStatus", "ScreenSource", "EvidenceCoverage", "DecisionContext",
  "RubricDimension", "RubricScore", "Perspective", "ExperimentBrief", "Tradeoff",
  "Publication",                 // schema.ts — Zod schema, consumed by CorpusEntry composition
  "entryTextFields",
  "ClaimBasis", "VisualSlopBasis",
  "VisualSlopFinding", "MotionGuidance", "StructuredRecommendation",
  "StructuredAccessibilityRisk", "AppliedReference",
  // PUBLIC_SNAPSHOT_DIR is consumed by server.ts (the executable entry that
  // resolves the default snapshot path), not by the exporter or reader (which
  // take paths as parameters for testability). The wiring-verification scan
  // excludes the scripts/ dir and server.ts is the executable entry, so the
  // symbol appears unreferenced from the scanned production set.
  "PUBLIC_SNAPSHOT_DIR",
  // Grounded-design pre-C2 foundation modules — pure contracts/policies created
  // in the grounded-design plan (Tasks 2–3). Consumed only by their tests today;
  // they gain production callers in later, separately-reviewed plans (UiSpec
  // generator consumes renderSourceDesign + DesignSourceSnapshot; hosted capture
  // consumes planRepresentativeCrawl + assertSafeHostedCaptureTarget). Listed
  // here rather than wired to a placeholder caller to avoid fake coupling.
  "renderSourceDesign",
  "planRepresentativeCrawl",
  "assertSafeHostedCaptureTarget",
  // readiness/contracts.ts — consumed by the validator script
  // (src/scripts/validate-readiness-artifacts.ts, created in Task 3).
  // These are the canonical helpers the validator calls directly.
  "computeTaxonomyDigest",
  "buildCheckpointTarget",
  "computeCheckpointTargetSha256",
  "validateRegistry",
  "validateLedgerAppendOnly",
  // tool-catalog.ts — consumed by tool-contracts.ts, checkpoint policy,
  // and the readiness validator (all created in C1 Steps 3-8).
  "TOOL_CATALOG",
  "REMOVED_TOOL_NAMES",
  "LEGACY_TO_BETA_MAP",
  "CATALOG_DIGEST",
  // tool-contracts.ts — consumed by handlers, renderers, and the readiness
  // validator (created in C1 Steps 5-8 and Task 7).
  "isAllowedRetrievalState",
  "getToolDataSchema",
  "ToolInputSchemas",
  "AcceptanceCriterion",
  "CitedDecision",
  "CreateUiSpecInputT",
  "AcceptanceCriterionT",
  "CitedDecisionT",
  "ALLOWED_RETRIEVAL_STATES",
  "getToolEvidenceRequired",
  // New descriptor exports consumed by Task 6-9 handlers
  "TOOL_DESCRIPTORS",
  "ToolResultSchemas",
  "ToolErrorUnion",
  "parseToolResult",
  "SearchInput",
  "WarningBase",
  // tool-contract-integrity.ts — consumed by makeEnvelope in tool-contracts.ts
  "validateEnvelopeRetrieval",
  "validateEvidenceReferences",
  "sameSet",
  "unique",
  // tool-contract-docs.ts — consumed by the drift test
  "extractGeneratedBlock",
  // readiness/checkpoint-policy.ts — CHECKPOINT_POLICIES is a configuration
  // constant consumed by the validator at runtime via the import
  // (CHECKPOINT_POLICIES[cp].requiredRoles / CHECKPOINT_POLICIES[recipe.checkpoint]).
  // The regex-based scan may not detect the dynamic `CHECKPOINT_POLICIES[cp]`
  // access pattern, so it is allowlisted here defensively.
  "CHECKPOINT_POLICIES",
  // c2/evaluation-contracts.ts — assertAgreementMatchesSubmissions is a runtime
  // cross-check that an agreement report binds to two distinct independent
  // submissions (Gold Label Owner + QA), matching hashes, roles, and the frozen
  // selection. It is the canonical guard the C2 agreement validator (a later,
  // separately-reviewed task) calls directly before publishing a report. Listed
  // here rather than wired to a placeholder caller to avoid fake coupling, per
  // the same precedent as renderSourceDesign / buildCheckpointTarget above.
  "assertAgreementMatchesSubmissions",
  // c2/label-agreement.ts — computeLabelAgreement is the pure algorithm that
  // compares the two independent label submissions (Gold Label Owner + external
  // QA) and emits the C2LabelAgreementReport. Its production caller is the C2
  // agreement validator (a separately-reviewed downstream task); the
  // collect-label-submissions.mts workflow helper only collects the submission
  // files, it does not run agreement. Listed here rather than wired to a
  // placeholder caller to avoid fake coupling, per the same precedent as
  // assertAgreementMatchesSubmissions above.
  "computeLabelAgreement",
  // c2/governance-contracts.ts — C2_REQUIRED_APPROVAL_ROLES declares the exact
  // future closure-role set (Gold Label Owner + QA). Consumed by the C2 closure
  // validator (Pass 6) and the provisional evidence manifest schema. Allowlisted
  // until Pass 6 wires it.
  "C2_REQUIRED_APPROVAL_ROLES",
  // c2/remediation-contracts.ts — assertProposalMatchesFailure is a runtime
  // cross-check binding a retag proposal to its source failure. Consumed by
  // the C2 remediation validator (Pass 5). Same foundation-awaiting-caller
  // pattern as the other C2 assertion exports.
  "assertProposalMatchesFailure",
  // c2/case-contracts.ts — gold-evidence descriptor + binding schemas. These
  // are consumed by the .mjs manifest builder (scripts/build-c2-pilot-manifest.mjs)
  // via the deferred dist/c2/case-contracts.js import, the same pattern as the
  // other dist-consumed symbols (MIN_WORDS, loadEnv, etc.) at the top of this
  // allowlist. The regex scan over src/*.ts cannot see the .mjs caller.
  "C2GoldEvidenceDescriptorSchema",
  "C2GoldEvidenceRecordSchema",
  "C2GoldEvidenceRecordBindingSchema",
  "C2PilotGoldEvidenceBindingSchema",
  // c2/cost-policy.ts — assertRunBudget / assertCampaignBudget are called by the
  // C2 harness (src/c2/harness.ts) after every forecast; preflightCampaignCosts
  // is called by the C2 pilot CLI (src/scripts/run-c2-pilot.ts) before every
  // c2/baseline-manifest.ts — computeManifestSha256 is the pure self-hash helper
  // consumed by the baseline builder script (Task B3, not yet implemented) and
  // the closure evaluator's manifest-binding step. Same foundation-awaiting-caller
  // pattern as computeLabelAgreement.
  "computeManifestSha256",
  // paid run. All three gained real production callers when the harness CLI
  // landed (PR 1) and were removed from this allowlist.
  // c2/condition-resolver.ts — resolveConditionInput is called by the C2 pilot
  // CLI's `prepare` command (src/scripts/run-c2-pilot.ts); removed from this
  // allowlist when the CLI became its production caller.
  // c2/private-artifacts.ts — writePrivateArtifact / writeDurableArtifact /
  // scanDurableArtifact are all called by the harness + CLI now (the harness
  // runs scanDurableArtifact before every durable write; the CLI routes private
  // and durable writes through the atomic primitives). Removed from this
  // allowlist once the CLI adopted the atomic-write path.
  // c2/review-packets.ts — Task 8 foundation helpers for the operational
  // review-batch flow (Task 10). `shufflePackets` is the spec §10 packet-order
  // shuffle (crypto.randomInt + rejection sampling); `createFileBlindMapStore`
  // is the file-backed reversible-map store under .c2-private/c2/blind-map.json.
  // The CLI's runPropose/runFreeze/runValidate (already wired) do not call them
  // yet — the batch packet emission is a Task 10 operational step during paid
  // execution. Listed here rather than wired to a placeholder caller to avoid
  // fake coupling, per the same precedent as cost-policy above.
  "shufflePackets",
  "createFileBlindMapStore",
  // c2/baseline-compatibility.ts — validateBaselineCompatibility is the pure
  // post-baseline contract guard: it parses the human-authored OpenAI-vs-Claude
  // compatibility evaluation for the 5 manifest-pinned independent runs,
  // rejects cliSynthesized:true, and set-matches the 5 refs against the expected
  // triples (artifactId + path + sha256). Its production caller is the
  // post-baseline compatibility gate (C2 Pass 4), an operational step run AFTER
  // the human fills eval/c2/baseline/compatibility-evaluation.template.json —
  // not the campaign CLI (run --paid) or the scorecards CLI. Listed here rather
  // than wired to a placeholder caller to avoid fake coupling, per the same
  // precedent as computeLabelAgreement / assertAgreementMatchesSubmissions /
  // computeManifestSha256 above.
  "validateBaselineCompatibility",
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

  // NOTE on allowlist hygiene: the scan's regex-based isReferencedInProduction
  // cannot cleanly distinguish a real CODE call from a comment/string match, so
  // a "no allowlisted symbol may be wired" invariant produces false positives
  // (e.g. ImageRef appears in comments, "Publication pipeline" is a string).
  // Allowlist truthiness is therefore a manual review concern, not an automated
  // invariant. The three inert entries removed in the hardening pass
  // (renderBriefTokens, renderDecisionBrief, pickDiverse — exported functions
  // with real call sites in their own defining file) were identified by hand.
  // The orphaned selectReferences was deleted outright. Re-audit the allowlist
  // manually when adding new entries.
});
