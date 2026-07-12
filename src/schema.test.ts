import { describe, expect, it } from "vitest";
import { Component, Corpus, CorpusEntry, Decision, detectPlatform, findDraftMarkers, formatAccessibilityRisk } from "./schema.js";

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
      "search", "checkout", "profile", "marketing-hero", "calculator",
      "data-table", "empty-state", "navigation", "forms", "mobile-nav",
      "notifications", "editor-canvas", "chat-interface", "command-palette", "modal",
    ];
    for (const patternType of types) {
      expect(CorpusEntry.safeParse({ ...validEntry, patternType }).success).toBe(true);
    }
  });

  it("defaults components to an empty evidence list when omitted", () => {
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.components).toEqual([]);
  });

  it("accepts visible component tags separately from categories", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      components: ["sidebar-nav", "kpi-card", "donut-chart", "line-chart", "report-list"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.components).toContain("kpi-card");
      expect(Component.options).toContain("gauge-chart");
      expect(Component.options).toContain("bottom-nav");
      expect(Component.options).toContain("action-list");
    }
  });

  it("rejects unknown component tags", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      components: ["chart-but-vibes"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts domainTags as optional business context", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      domainTags: ["billing", "usage"],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domainTags).toEqual(["billing", "usage"]);
  });

  it("rejects unknown domainTags values", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      domainTags: ["billing", "made-up-domain"],
    });
    expect(result.success).toBe(false);
  });

  // ── additive v2 fields: qualityTier, voice, colorRoles, lastVerified ───────

  it("defaults qualityTier to 'exceptional' when omitted", () => {
    const { qualityTier: _omit, ...withoutTier } = validEntry;
    const result = CorpusEntry.safeParse(withoutTier);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.qualityTier).toBe("exceptional");
  });

  it("accepts qualityTier: 'cautionary'", () => {
    const result = CorpusEntry.safeParse({ ...validEntry, qualityTier: "cautionary", qualityScore: 2 });
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

  it("accepts businessRationale undefined (optional)", () => {
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.businessRationale).toBeUndefined();
  });

  it("round-trips a populated businessRationale block with confirmed defaulting false", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      businessRationale: {
        businessGoal: "reduce-support-load",
        targetUser: "self-serve SMB admin",
        rationale: "The compact summary lets admins answer common setup questions without opening support docs.",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessRationale).toEqual({
        businessGoal: "reduce-support-load",
        targetUser: "self-serve SMB admin",
        rationale: "The compact summary lets admins answer common setup questions without opening support docs.",
        confirmed: false,
      });
    }
  });

  it("rejects an invalid businessRationale businessGoal", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      businessRationale: {
        businessGoal: "make-it-pop",
        targetUser: "self-serve SMB admin",
        rationale: "The compact summary lets admins answer common setup questions without opening support docs.",
      },
    });
    expect(result.success).toBe(false);
  });

  it("enforces businessRationale targetUser and rationale max lengths", () => {
    expect(CorpusEntry.safeParse({
      ...validEntry,
      businessRationale: {
        businessGoal: "other",
        targetUser: "x".repeat(81),
        rationale: "Short rationale.",
      },
    }).success).toBe(false);

    expect(CorpusEntry.safeParse({
      ...validEntry,
      businessRationale: {
        businessGoal: "other",
        targetUser: "admin",
        rationale: "x".repeat(281),
      },
    }).success).toBe(false);
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

  it("accepts pinned: true and treats absence as undefined (not false)", () => {
    const pinned = CorpusEntry.safeParse({ ...validEntry, pinned: true });
    expect(pinned.success).toBe(true);
    if (pinned.success) expect(pinned.data.pinned).toBe(true);

    const omitted = CorpusEntry.safeParse(validEntry);
    expect(omitted.success).toBe(true);
    if (omitted.success) expect(omitted.data.pinned).toBeUndefined();
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

  // ── capture provenance (additive, nested on provenance) ──────────────────────

  it("round-trips a populated provenance.capture block", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      provenance: {
        taggedBy: "auto",
        capture: {
          mode: "section",
          viewport: "desktop",
          selectorPath: "main > section.hero",
          capturedAt: "2026-07-05T10:30:00.000Z",
          sourceUrl: "https://example.com/pricing",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provenance?.capture).toEqual({
        mode: "section",
        viewport: "desktop",
        selectorPath: "main > section.hero",
        capturedAt: "2026-07-05T10:30:00.000Z",
        sourceUrl: "https://example.com/pricing",
      });
    }
  });

  it("treats entries with provenance but no capture as valid", () => {
    // Manual-upload captures from the tagger don't set a capture block — they
    // must still validate (capture is purely additive).
    const result = CorpusEntry.safeParse({
      ...validEntry,
      provenance: { taggedBy: "auto" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.provenance?.capture).toBeUndefined();
  });

  it("rejects an invalid provenance.capture.mode", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      provenance: {
        taggedBy: "auto",
        capture: {
          mode: "bogus",
          viewport: "desktop",
          capturedAt: "2026-07-05T10:30:00.000Z",
          sourceUrl: "https://example.com/pricing",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("treats entries without provenance as valid (backward-compat, no migration)", () => {
    // Existing entries have no provenance field — they must still validate.
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.provenance).toBeUndefined();
  });

  // ── qualityScore / qualityTier coupling ─────────────────────────────────────

  it("rejects cautionary entries with qualityScore > 2", () => {
    const result = CorpusEntry.safeParse({ ...validEntry, qualityTier: "cautionary", qualityScore: 3 });
    expect(result.success).toBe(false);
  });

  it("rejects exceptional entries with qualityScore < 3", () => {
    const result = CorpusEntry.safeParse({ ...validEntry, qualityTier: "exceptional", qualityScore: 2 });
    expect(result.success).toBe(false);
  });

  it("accepts cautionary with qualityScore 1-2", () => {
    expect(CorpusEntry.safeParse({ ...validEntry, qualityTier: "cautionary", qualityScore: 1 }).success).toBe(true);
    expect(CorpusEntry.safeParse({ ...validEntry, qualityTier: "cautionary", qualityScore: 2 }).success).toBe(true);
  });

  it("accepts exceptional with qualityScore 3-5", () => {
    expect(CorpusEntry.safeParse({ ...validEntry, qualityTier: "exceptional", qualityScore: 5 }).success).toBe(true);
  });

  // ── structured accessibility risks (evidence gate) ──────────────────────────

  it("accepts legacy string accessibility risks", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        legacyAccessibilityNotes: ["[inferred] sidebar: possible contrast issue for small text"],
        accessibilityRisks: [],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects legacy string accessibility risks in the active array", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        accessibilityRisks: ["[inferred] sidebar: possible contrast issue" as never],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts structured accessibility risks with canonical WCAG IDs", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        accessibilityRisks: [{
          element: "left sidebar navigation",
          risk: "Icon labels may be difficult to scan for low-vision users at small sizes.",
          evidence: "visible labels: Home, Cards, Transactions, Balance",
          confidence: "visible",
          wcag: ["1.4.3"],
        }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects canonical-looking WCAG IDs missing from the registry", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        accessibilityRisks: [{
          element: "status indicator",
          risk: "State is communicated by color alone, which some users may miss.",
          evidence: "red and green dots distinguish failed and paid rows without text labels",
          confidence: "visible",
          wcag: ["9.9.9"],
        }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects structured accessibility risks without a wcag array", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        accessibilityRisks: [{
          element: "sidebar",
          risk: "Icon-only controls may lack accessible names for screen reader users.",
          evidence: "the sidebar icons have no visible text labels",
          confidence: "inferred",
        } as never],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects structured accessibility risks with an empty wcag array", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        accessibilityRisks: [{
          element: "sidebar",
          risk: "Icon-only controls may lack accessible names for screen reader users.",
          evidence: "the sidebar icons have no visible text labels",
          confidence: "inferred",
          wcag: [],
        }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("findDraftMarkers scans structured accessibility risk text fields", () => {
    const entry = CorpusEntry.parse({
      ...validEntry,
      antiPatterns: {
        ...validEntry.antiPatterns,
        accessibilityRisks: [{
          element: "status row",
          risk: "[DRAFT] Color-only status may fail for color-blind users.",
          evidence: "red dot next to Failed row",
          confidence: "visible",
          wcag: ["1.4.1"],
        }],
      },
    });
    expect(findDraftMarkers(entry)).toContain("antiPatterns.accessibilityRisks[0].risk");
  });

  it("accepts persisted pattern discovery suggestions", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      patternDiscovery: {
        suggestedPatternType: "monitoring-console",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.patternDiscovery?.suggestedPatternType).toBe("monitoring-console");
    }
  });

  it("formats structured accessibility risks with WCAG titles without losing evidence", () => {
    expect(formatAccessibilityRisk({
      element: "status dot",
      risk: "Color is the only visible status channel.",
      evidence: "8px red/green dots beside Paid and Failed rows",
      confidence: "visible",
      wcag: ["1.4.1"],
    }, { includeEvidence: true })).toContain("Evidence: 8px red/green dots");
  });

  it("formats WCAG IDs with their registry titles", () => {
    const formatted = formatAccessibilityRisk({
      element: "status dot",
      risk: "Color is the only visible status channel.",
      evidence: "red/green dots beside Paid and Failed rows",
      confidence: "visible",
      wcag: ["1.4.1"],
    });
    expect(formatted).toContain("1.4.1 Use of Color");
  });

  // ── publication (Gate 1A — optional, no default for zero-churn) ──────────────

  it("accepts a fully-populated publication block", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      publication: {
        visibility: "public",
        clearance: "approved",
        rightsBasis: "owned",
        evidenceRef: "docs/rights/linear-issue-board.md",
        reviewedAt: "2026-07-01",
        reviewedBy: "nifabulous",
        expiresAt: "2027-07-01",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an entry with no publication field (optional)", () => {
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.publication).toBeUndefined();
  });

  it("rejects an invalid publication.visibility enum", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      publication: { visibility: "secret", clearance: "approved" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid publication.clearance enum", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      publication: { visibility: "public", clearance: "pending" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed publication.reviewedAt (not YYYY-MM-DD)", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      publication: {
        visibility: "public",
        clearance: "approved",
        reviewedAt: "July 1, 2026",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed publication.expiresAt (not YYYY-MM-DD)", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      publication: {
        visibility: "public",
        clearance: "approved",
        expiresAt: "2026/07/01",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts publication with only required fields (visibility + clearance)", () => {
    const result = CorpusEntry.safeParse({
      ...validEntry,
      publication: { visibility: "private", clearance: "unreviewed" },
    });
    expect(result.success).toBe(true);
  });

  it("does NOT materialize publication on round-trip when absent (zero-churn, D17)", () => {
    // Construct an entry WITHOUT publication, run it through the
    // Corpus.parse → JSON.stringify → re-parse round-trip that persistEntries
    // performs, and assert the re-parsed entry still has NO publication field.
    // This is the load-bearing test for the no-default decision: .optional()
    // (no .default) means absent stays absent through parse → serialize.
    const parsed = Corpus.parse({ version: 2, entries: [validEntry] });
    expect(parsed.entries[0].publication).toBeUndefined();

    const serialized = JSON.stringify(parsed);
    const reparsed = Corpus.parse(JSON.parse(serialized));

    expect(reparsed.entries[0].publication).toBeUndefined();
  });

  it("does NOT materialize publication sub-fields on round-trip when partial", () => {
    // A publication block with only visibility+clearance must survive round-trip
    // without the optional sub-fields (rightsBasis, evidenceRef, etc.) being
    // filled in with defaults — that would be churn.
    const parsed = Corpus.parse({
      version: 2,
      entries: [{
        ...validEntry,
        publication: { visibility: "private", clearance: "unreviewed" },
      }],
    });
    const serialized = JSON.stringify(parsed);
    const reparsed = Corpus.parse(JSON.parse(serialized));

    expect(reparsed.entries[0].publication).toEqual({
      visibility: "private",
      clearance: "unreviewed",
    });
  });
});

describe("detectPlatform", () => {
  it("classifies portrait dimensions as mobile", () => {
    expect(detectPlatform(1284, 2778)).toBe("mobile"); // iPhone screenshot
    expect(detectPlatform(750, 1334)).toBe("mobile");
  });

  it("classifies landscape dimensions as web", () => {
    expect(detectPlatform(1920, 1080)).toBe("web");
    expect(detectPlatform(1440, 900)).toBe("web");
  });

  it("classifies roughly-square dimensions as tablet", () => {
    // Tablet is the middle band: height/width between 0.83 and 1.2.
    expect(detectPlatform(820, 980)).toBe("tablet");   // 1.195 — just under the mobile threshold
    expect(detectPlatform(800, 800)).toBe("tablet");   // exactly square
    expect(detectPlatform(1024, 900)).toBe("tablet");  // mildly landscape, not enough for web
  });

  it("defaults to web when dimensions are missing", () => {
    expect(detectPlatform(null, null)).toBe("web");
    expect(detectPlatform(undefined, undefined)).toBe("web");
  });

  it("accepts platform as an optional field on entries (backward-compat)", () => {
    // Existing entries without platform must still validate.
    const result = CorpusEntry.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.platform).toBeUndefined();
  });

  it("round-trips an explicit platform value", () => {
    for (const platform of ["web", "mobile", "tablet"] as const) {
      const result = CorpusEntry.safeParse({ ...validEntry, platform });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.platform).toBe(platform);
    }
  });
});

describe("Decision schema", () => {
  const validContext = {
    targetUser: "First-time visitors",
    businessGoal: "Make the value prop clear in 10 seconds",
    primaryKpi: "Trial starts",
  };

  it("accepts a minimal valid single-screen decision", () => {
    const result = Decision.safeParse({
      id: "choose-homepage-direction",
      title: "Choose the homepage direction",
      createdAt: "2026-07-10",
      updatedAt: "2026-07-10",
      context: validContext,
      scope: "screen",
      directions: [
        {
          id: "dir-a",
          name: "Hero with product screenshot",
          screens: [{ id: "scr-1", order: 0, source: "upload", imageRef: "corpus/images-private/decisions/shot.png" }],
        },
        {
          id: "dir-b",
          name: "Bold headline + CTA",
          screens: [{ id: "scr-2", order: 0, source: "upload", imageRef: "corpus/images-private/decisions/shot2.png" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires at least two directions", () => {
    const result = Decision.safeParse({
      id: "lonely",
      title: "T",
      createdAt: "2026-07-10",
      updatedAt: "2026-07-10",
      context: validContext,
      scope: "screen",
      directions: [
        { id: "dir-a", name: "A", screens: [{ id: "scr-1", order: 0, source: "upload", imageRef: "x.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than three directions", () => {
    const directions = [0, 1, 2, 3].map((i) => ({
      id: `dir-${i}`, name: `D${i}`,
      screens: [{ id: `scr-${i}`, order: 0, source: "upload" as const, imageRef: "x.png" }],
    }));
    const result = Decision.safeParse({
      id: "too-many", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "screen", directions,
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one screen per direction", () => {
    const result = Decision.safeParse({
      id: "empty-dir", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "screen",
      directions: [
        { id: "dir-a", name: "A", screens: [] },
        { id: "dir-b", name: "B", screens: [{ id: "scr-1", order: 0, source: "upload", imageRef: "x.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects flow scope in increment 1", () => {
    const result = Decision.safeParse({
      id: "flow-not-yet", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "flow",
      directions: [
        { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "upload", imageRef: "x.png" }] },
        { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "y.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects figma source in increment 1", () => {
    const result = Decision.safeParse({
      id: "figma-not-yet", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "screen",
      directions: [
        { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "figma", imageRef: "x.png" }] },
        { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "y.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });
});
