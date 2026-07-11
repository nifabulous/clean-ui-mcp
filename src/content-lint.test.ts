import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lintAntiPattern, findVagueAntiPatterns, VAGUE_PHRASES } from "./content-lint.js";
import { VAGUE_PHRASES as GENERATED_VAGUE_PHRASES } from "./references/generated.js";
import { findDraftMarkers, CorpusEntry } from "./schema.js";
import type { CorpusEntryT } from "./schema.js";
import { validateEntryPayload } from "./scripts/ui-server.js";
import { validateEntryGates } from "./scripts/add-entry.js";

// Minimal entry shape — only antiPatterns.antiPatterns matters for these tests.
function entryWith(antiPatterns: string[]): CorpusEntryT {
  return {
    antiPatterns: {
      antiPatterns,
      whereThisFails: [],
      accessibilityRisks: [],
      legacyAccessibilityNotes: [],
    },
  } as unknown as CorpusEntryT;
}

describe("lintAntiPattern", () => {
  it("flags vague phrases", () => {
    const issues = lintAntiPattern("This design will keep it clean and avoid clutter.");
    expect(issues).toContain('generic filler: "keep it clean"');
    expect(issues).toContain('generic filler: "avoid clutter"');
  });

  it("flags vague phrases with curly apostrophes (don\\u2019t overdo it)", () => {
    // The phrase list has a straight apostrophe; the author's editor may insert
    // a curly one. Normalization must fold them together.
    const issues = lintAntiPattern("This design will keep it simple and don\u2019t overdo it.");
    expect(issues).toContain('generic filler: "keep it simple"');
    expect(issues).toContain('generic filler: "don\'t overdo it"');
  });

  it("flags short text (< 8 words)", () => {
    expect(lintAntiPattern("Avoids bad drop shadows.")).toContain("too short (<8 words)");
  });

  it("passes specific, detailed anti-patterns", () => {
    expect(
      lintAntiPattern("Uses highly saturated accents on small text over warm backgrounds, which triggers chromatic aberration."),
    ).toEqual([]);
  });
});

describe("findVagueAntiPatterns", () => {
  it("returns hard-block issues for vague phrases on antiPatterns.antiPatterns only", () => {
    const issues = findVagueAntiPatterns(
      entryWith([
        "keep it clean and consistent",
        "Avoids heavy drop shadows on static containers that don't need depth cues.",
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("antiPatterns.antiPatterns[0]");
    expect(issues[0].issues.length).toBeGreaterThan(0);
  });

  it("returns empty for clean entries", () => {
    const issues = findVagueAntiPatterns(
      entryWith([
        "Reserves the brightest accent color for the single element that must win attention so state remains unmistakable.",
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("uses the generated vague phrase list", () => {
    expect(VAGUE_PHRASES).toEqual(GENERATED_VAGUE_PHRASES);
  });
});

describe("enforcement-rule consumers", () => {
  it("imports generated rules instead of declaring private detector copies", () => {
    const consumers = [
      new URL("./tagger.ts", import.meta.url),
      new URL("./content-lint.ts", import.meta.url),
      new URL("../scripts/eval-scorer.mjs", import.meta.url),
    ];
    const duplicateDeclarations = /const (?:BANNED_PHRASES|VAGUE_PHRASES|UNLABELED_CONTROL|PIXEL_MEASUREMENT)\b/;

    for (const consumer of consumers) {
      const source = readFileSync(fileURLToPath(consumer), "utf8");
      expect(source).toMatch(/references\/generated/);
      expect(source).not.toMatch(duplicateDeclarations);
    }
  });
});

// ── Four-path regression: draft hygiene + vague-phrase gates ─────────────────
// Proves both gates fire across all four write paths. A refactor that silently
// stops a check from firing is the exact regression this catches.

function validEntry(overrides: Record<string, unknown> = {}): CorpusEntryT {
  return CorpusEntry.parse({
    id: "regression-test",
    title: "Regression Test",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: { productName: "Test", url: "https://test.example.com", capturedAt: "2026-07-10", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/test.png", width: 100, height: 100 },
    visual: {
      dominantColors: ["#ffffff"], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: false,
    },
    critique: "A sufficiently long critique explaining the design decision, its effect on the user, and what conventional default it rejects.",
    whatToSteal: ["A specific concrete technique a developer could reproduce with care."],
    antiPatterns: {
      antiPatterns: ["A specific mistake this design avoids with clear reasoning and consequence for the user."],
      whereThisFails: [],
      accessibilityRisks: [],
      legacyAccessibilityNotes: [],
    },
    qualityTier: "exceptional",
    qualityScore: 3,
    reviewStatus: "approved",
    addedAt: "2026-07-10",
    ...overrides,
  });
}

// ── Write-path gate coverage ─────────────────────────────────────────────────
// Two paths have genuine integration tests (ui-server via validateEntryPayload,
// add-entry via validateEntryGates). commit-draft and validate-corpus are CLI
// scripts that read files at module load, so they're structurally hard to unit-
// test — their gate wiring is covered by the shared-function tests below + CI.

describe("write-path gates: ui-server (integrated)", () => {
  it("rejects draft markers via validateEntryPayload", () => {
    const e = validEntry({ critique: "[PLACEHOLDER] fix this later with real content that is long enough to pass the 80 char minimum." });
    expect(() => validateEntryPayload(e)).toThrow(/draft markers/);
  });
  it("rejects vague phrases via validateEntryPayload", () => {
    const e = validEntry({
      antiPatterns: {
        antiPatterns: ["This design will keep it clean and avoid clutter everywhere."],
        whereThisFails: [], accessibilityRisks: [], legacyAccessibilityNotes: [],
      },
    });
    expect(() => validateEntryPayload(e)).toThrow(/generic filler/);
  });
});

describe("write-path gates: add-entry (integrated via validateEntryGates)", () => {
  it("blocks draft markers — returns a non-null error", () => {
    const e = validEntry({ critique: "[TODO] write the actual critique text here now before this entry can be saved properly." });
    expect(validateEntryGates(e)).not.toBeNull();
    expect(validateEntryGates(e)).toContain("draft/placeholder");
  });
  it("blocks vague phrases — returns a non-null error naming the filler", () => {
    const e = validEntry({
      antiPatterns: {
        antiPatterns: ["keep it simple and don't overdo it in the layout"],
        whereThisFails: [], accessibilityRisks: [], legacyAccessibilityNotes: [],
      },
    });
    const err = validateEntryGates(e);
    expect(err).not.toBeNull();
    expect(err).toContain("keep it simple");
    expect(err).toContain("don't overdo it");
  });
  it("passes a clean entry — returns null", () => {
    expect(validateEntryGates(validEntry())).toBeNull();
  });
});

// commit-draft, validate-corpus, and bulk-import→commit-draft all use the shared
// findDraftMarkers + findVagueAntiPatterns functions. These tests prove the
// PREDICATE catches dirty entries; CI proves the SCRIPTS wire it in.
describe("shared gate functions (used by commit-draft + validate-corpus)", () => {
  it("findDraftMarkers catches [DRAFT] critique", () => {
    const e = validEntry({ critique: "[DRAFT] needs rewriting into final prose form now before it can ship to the corpus." });
    expect(findDraftMarkers(e).length).toBeGreaterThan(0);
  });
  it("findVagueAntiPatterns catches generic filler", () => {
    const e = validEntry({
      antiPatterns: {
        antiPatterns: ["bad ux and poor ux everywhere in the layout design"],
        whereThisFails: [], accessibilityRisks: [], legacyAccessibilityNotes: [],
      },
    });
    expect(findVagueAntiPatterns(e).length).toBeGreaterThan(0);
  });
});
