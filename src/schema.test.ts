import { describe, expect, it } from "vitest";
import { CorpusEntry } from "./schema.js";

const validEntry = {
  id: "example-product-dashboard",
  title: "Example Product - Dashboard",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  source: {
    productName: "Example",
    url: "https://example.com",
    capturedAt: "2026-07-01",
    capturedBy: "self",
  },
  image: {
    visibility: "private",
    path: "images-private/example.png",
    width: null,
    height: null,
  },
  visual: {
    dominantColors: ["#ffffff", "#111111"],
    accentColor: "#635bff",
    typePairing: {
      display: "Inter",
      body: "Inter",
      notes: "Hierarchy comes from weight and restrained color.",
    },
    spacingDensity: "moderate",
    cornerStyle: "slight-round",
    usesShadows: false,
    usesBorders: true,
  },
  critique:
    "This example uses restrained contrast, clear type hierarchy, and quiet borders to create a focused interface without decorative noise.",
  whatToSteal: ["Use low-contrast borders to separate dense regions without adding visual clutter."],
  antiPatterns: {
    antiPatterns: ["Avoids drop shadows; uses background-color steps for depth instead."],
    whereThisFails: [],
    accessibilityRisks: [],
  },
  qualityScore: 4,
  addedAt: "2026-07-01",
} as const;

describe("corpus schema", () => {
  it("accepts valid private corpus-relative image paths", () => {
    expect(CorpusEntry.safeParse(validEntry).success).toBe(true);
  });

  it("rejects absolute image paths", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      image: { ...validEntry.image, path: "/tmp/example.png" },
    });

    expect(result.success).toBe(false);
  });

  it("requires public images to live in images-public with dimensions", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      image: {
        visibility: "public-thumb",
        path: "images-private/example.png",
        width: null,
        height: null,
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-slug ids and non-ISO dates", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      id: "Example Product Dashboard",
      addedAt: "July 1, 2026",
    });

    expect(result.success).toBe(false);
  });

  it("allows uploaded samples without a source URL", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      source: { ...validEntry.source, url: null },
    });

    expect(result.success).toBe(true);
  });

  // ── v2 schema: patternType + antiPatterns ──────────────────────────────────

  it("rejects an entry missing the required patternType field", () => {
    const { patternType: _omit, ...withoutPattern } = validEntry;
    const result = CorpusEntry.safeParse(withoutPattern);
    expect(result.success).toBe(false);
  });

  it("rejects an entry with an empty antiPatterns.antiPatterns array", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: { ...validEntry.antiPatterns, antiPatterns: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts defaults for whereThisFails and accessibilityRisks when omitted", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: { antiPatterns: validEntry.antiPatterns.antiPatterns },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.antiPatterns.whereThisFails).toEqual([]);
      expect(result.data.antiPatterns.accessibilityRisks).toEqual([]);
    }
  });

  it("accepts every valid PatternType enum value", () => {
    const types = [
      "dashboard", "landing-page", "pricing", "onboarding", "auth", "settings",
      "search", "checkout", "profile", "marketing-hero",
      "data-table", "empty-state", "navigation", "forms", "mobile-nav",
      "notifications", "editor-canvas", "chat-interface", "command-palette", "modal",
    ];
    for (const patternType of types) {
      expect(CorpusEntry.safeParse({ ...validEntry, patternType }).success).toBe(true);
    }
  });

  // ── additive v2 fields: qualityTier, voice, colorRoles, lastVerified ───────

  it("defaults qualityTier to 'exceptional' when omitted", () => {
    const { qualityTier: _omit, ...withoutTier } = validEntry;
    const result = CorpusEntry.safeParse(withoutTier);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.qualityTier).toBe("exceptional");
  });

  it("accepts qualityTier: 'cautionary'", () => {
    const result = CorpusEntry.safeParse({ ...validEntry, qualityTier: "cautionary" });
    expect(result.success).toBe(true);
  });

  it("accepts a populated voice block", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      voice: { tone: "restrained and dry", examples: ["Good afternoon, Sam"], avoid: ["no exclamation enthusiasm"] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts voice undefined (optional)", () => {
    expect(CorpusEntry.safeParse(validEntry).success).toBe(true);
  });

  it("accepts a populated colorRoles token set", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      visual: { ...validEntry.visual, colorRoles: { canvas: "#fcfcfd", surface: "#ffffff", ink: "#18181b", muted: "#71717a", accent: "#635bff" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts colorRoles with muted: null", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      visual: { ...validEntry.visual, colorRoles: { canvas: "#fcfcfd", surface: "#ffffff", ink: "#18181b", muted: null, accent: "#635bff" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts source.lastVerified as an optional ISO date", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      source: { ...validEntry.source, lastVerified: "2026-07-01" },
    });
    expect(result.success).toBe(true);
  });

  it("defaults reviewStatus to 'approved' when omitted", () => {
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reviewStatus).toBe("approved");
  });

  it("round-trips an explicit reviewStatus: 'draft'", () => {
    const result = CorpusEntry.safeParse({ ...validEntry, reviewStatus: "draft" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reviewStatus).toBe("draft");
  });

  it("round-trips provenance with all three taggedBy values", () => {
    for (const taggedBy of ["human", "auto", "auto-reviewed"] as const) {
      const result = CorpusEntry.safeParse({ ...validEntry, provenance: { taggedBy } });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.provenance?.taggedBy).toBe(taggedBy);
    }
  });

  it("accepts provenance.reviewedBy as an optional name", () => {
    const result = CorpusEntry.safeParse({ ...validEntry, provenance: { taggedBy: "auto-reviewed", reviewedBy: "nifabulous" } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.provenance?.reviewedBy).toBe("nifabulous");
  });

  it("treats entries without provenance as valid (backward-compat, no migration)", () => {
    // Existing entries have no provenance field — they must still validate.
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.provenance).toBeUndefined();
  });
});
