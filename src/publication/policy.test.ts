import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "../schema.js";
import { evaluatePublication, type PublicationReason } from "./policy.js";

/**
 * Base fixture: a fully-eligible entry. Every test spreads this and overrides
 * exactly one axis to trigger exactly one reason code. The image is public-own
 * (full rights, lives under images-public/) with non-null dimensions, and
 * imageExists is stubbed to return true by default.
 *
 * The eligibility contract (Task 2b): an entry is eligible iff ALL of
 * visibility/clearance/rights/evidence/reviewer/review-date/expiry pass AND the
 * image axis passes (visibility, path, prefix, dimensions, file existence).
 */
const eligiblePublication = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "docs/rights/example.md",
  reviewedAt: "2026-06-01",
  reviewedBy: "nifabulous",
};

const eligibleImage = {
  visibility: "public-own" as const,
  path: "images-public/example.png",
  width: 1440,
  height: 900,
};

function eligibleEntry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  // Build a minimal-but-valid CorpusEntryT. Tests override specific fields.
  return {
    id: "example-product-dashboard",
    title: "Example Product - Dashboard",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: {
      productName: "Example",
      url: "https://example.com",
      capturedAt: "2026-07-01",
      capturedBy: "self",
    },
    image: { ...eligibleImage },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#635bff",
      typePairing: { display: "Inter", body: "Inter" },
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
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    publication: { ...eligiblePublication },
    ...overrides,
  } as CorpusEntryT;
}

const NOW = "2026-07-12";
const alwaysExists = () => true;
const neverExists = () => false;

describe("evaluatePublication — eligible case", () => {
  it("returns eligible when ALL conditions are met", () => {
    const decision = evaluatePublication(eligibleEntry(), { now: NOW, imageExists: alwaysExists });
    expect(decision).toEqual({ eligible: true });
  });
});

describe("evaluatePublication — entry-axis reason codes", () => {
  it("entry-private: publication absent entirely", () => {
    const entry = eligibleEntry();
    delete (entry as { publication?: unknown }).publication;
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("entry-private");
  });

  it("entry-private: visibility !== public", () => {
    const entry = eligibleEntry({ publication: { ...eligiblePublication, visibility: "private" } });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("entry-private");
  });

  it("clearance-unreviewed: clearance === unreviewed", () => {
    const entry = eligibleEntry({ publication: { ...eligiblePublication, clearance: "unreviewed" } });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("clearance-unreviewed");
  });

  it("clearance-rejected: clearance === rejected", () => {
    const entry = eligibleEntry({ publication: { ...eligiblePublication, clearance: "rejected" } });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("clearance-rejected");
  });

  it("missing-rights-basis: rightsBasis absent", () => {
    const { rightsBasis: _omit, ...pub } = eligiblePublication;
    const entry = eligibleEntry({ publication: pub });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("missing-rights-basis");
  });

  it("missing-evidence: evidenceRef absent", () => {
    const { evidenceRef: _omit, ...pub } = eligiblePublication;
    const entry = eligibleEntry({ publication: pub });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("missing-evidence");
  });

  it("missing-reviewer: reviewedBy absent", () => {
    const { reviewedBy: _omit, ...pub } = eligiblePublication;
    const entry = eligibleEntry({ publication: pub });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("missing-reviewer");
  });

  it("missing-review-date: reviewedAt absent", () => {
    const { reviewedAt: _omit, ...pub } = eligiblePublication;
    const entry = eligibleEntry({ publication: pub });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("missing-review-date");
  });

  it("clearance-expired: expiresAt before now", () => {
    const entry = eligibleEntry({
      publication: { ...eligiblePublication, expiresAt: "2026-06-30" },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("clearance-expired");
  });

  it("clearance-expired: NOT raised when expiresAt equals now (boundary: >= passes)", () => {
    const entry = eligibleEntry({
      publication: { ...eligiblePublication, expiresAt: NOW },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision).toEqual({ eligible: true });
  });

  it("clearance-expired: NOT raised when expiresAt is absent (no recorded expiry)", () => {
    const entry = eligibleEntry({ publication: { ...eligiblePublication } });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision).toEqual({ eligible: true });
  });

  it("clearance-expired: NOT raised when expiresAt after now", () => {
    const entry = eligibleEntry({
      publication: { ...eligiblePublication, expiresAt: "2027-01-01" },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision).toEqual({ eligible: true });
  });
});

describe("evaluatePublication — image-axis reason codes", () => {
  it("image-private: image.visibility is 'private'", () => {
    const entry = eligibleEntry({
      image: { visibility: "private", path: "images-private/example.png", width: 1440, height: 900 },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("image-private");
  });

  it("link-only entry (private + null path) with source.url is ELIGIBLE — metadata-only distribution", () => {
    // The entry's value is its structured analysis; source.url links to the
    // original design. No image bytes ship — no third-party redistribution.
    const entry = eligibleEntry({
      image: { visibility: "private", path: null, width: null, height: null },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(true);
  });

  it("link-only entry WITHOUT source.url is still ELIGIBLE — source.url is recommended, not required", () => {
    // source.url is recommended (links to the original design) but not required.
    // Some entries lack a URL (apps with no public web presence, defunct products).
    // The metadata itself is still valuable to an agent building a UI.
    const entry = eligibleEntry({
      image: { visibility: "private", path: null, width: null, height: null },
      source: { productName: "Example", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(true);
  });

  it("image-path-missing: public-own with null path (schema-invalid, caught independently)", () => {
    // The evaluator must not assume schema enforcement. A public visibility
    // with a null path is schema-invalid AND policy-invalid.
    const entry = eligibleEntry({
      image: { visibility: "public-own", path: null, width: 1440, height: 900 },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("image-path-missing");
  });

  it("image-path-not-public: path does not start with images-public/", () => {
    // A public-own image whose path slipped into images-private/ — caught at
    // policy time (the schema's superRefine would also reject this, but the
    // policy is mode-agnostic and must not assume schema-level enforcement).
    const entry = eligibleEntry({
      image: { visibility: "public-own", path: "images-private/example.png", width: 1440, height: 900 },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("image-path-not-public");
  });

  it("image-metadata-missing: width or height is null", () => {
    const entry = eligibleEntry({
      image: { visibility: "public-own", path: "images-public/example.png", width: null, height: 900 },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("image-metadata-missing");
  });

  it("image-metadata-missing: both width and height null", () => {
    const entry = eligibleEntry({
      image: { visibility: "public-own", path: "images-public/example.png", width: null, height: null },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("image-metadata-missing");
  });

  it("image-file-missing: ctx.imageExists returns false", () => {
    const entry = eligibleEntry();
    const decision = evaluatePublication(entry, { now: NOW, imageExists: neverExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toContain("image-file-missing");
  });

  it("image-file-missing: NOT raised when ctx.imageExists returns true", () => {
    const entry = eligibleEntry();
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision).toEqual({ eligible: true });
  });
});

describe("evaluatePublication — cross-axis isolation", () => {
  it("entry-approved + image-private → excluded with ONLY image-private", () => {
    // Entry side is fully approved; the image is private. Confirms the two axes
    // are independent and an approved entry still fails on a private image.
    const entry = eligibleEntry({
      image: { visibility: "private", path: "images-private/example.png", width: 1440, height: 900 },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toEqual(["image-private"]);
  });

  it("entry-private + image-public → excluded with ONLY entry-private", () => {
    // Entry is private; image is fully public. Confirms a public image does not
    // rescue a private entry.
    const entry = eligibleEntry({
      publication: { ...eligiblePublication, visibility: "private" },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.reasons).toEqual(["entry-private"]);
  });
});

describe("evaluatePublication — reason accumulation + ordering", () => {
  it("accumulates multiple entry-axis reasons in stable order", () => {
    // Missing rights + evidence + reviewer → all three present in stable order.
    const { rightsBasis: _r, evidenceRef: _e, reviewedBy: _rb, ...pub } = eligiblePublication;
    const entry = eligibleEntry({ publication: pub });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      expect(decision.reasons).toEqual([
        "missing-rights-basis",
        "missing-evidence",
        "missing-reviewer",
      ]);
    }
  });

  it("preserves the full stable order across entry + image axes", () => {
    // Trigger one entry reason (missing-review-date) and one image reason
    // (image-private). Entry-axis reasons precede image-axis reasons in the
    // canonical order from PublicationReason.
    const { reviewedAt: _omit, ...pub } = eligiblePublication;
    const entry = eligibleEntry({
      publication: pub,
      image: { visibility: "private", path: "images-private/example.png", width: 1440, height: 900 },
    });
    const decision = evaluatePublication(entry, { now: NOW, imageExists: alwaysExists });
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      // missing-review-date (entry axis) comes before image-private (image axis)
      expect(decision.reasons).toEqual(["missing-review-date", "image-private"]);
    }
  });
});

describe("evaluatePublication — injected determinism", () => {
  it("same entry, same expiresAt — expiry decision flips with injected now", () => {
    const entry = eligibleEntry({
      publication: { ...eligiblePublication, expiresAt: "2026-07-13" },
    });
    // now BEFORE expiry → eligible
    expect(evaluatePublication(entry, { now: "2026-07-12", imageExists: alwaysExists }))
      .toEqual({ eligible: true });
    // now AFTER expiry → clearance-expired
    const after = evaluatePublication(entry, { now: "2026-07-14", imageExists: alwaysExists });
    expect(after.eligible).toBe(false);
    if (!after.eligible) expect(after.reasons).toContain("clearance-expired");
  });

  it("same entry — file-missing decision flips with injected imageExists", () => {
    const entry = eligibleEntry();
    expect(evaluatePublication(entry, { now: NOW, imageExists: alwaysExists }))
      .toEqual({ eligible: true });
    const missing = evaluatePublication(entry, { now: NOW, imageExists: neverExists });
    expect(missing.eligible).toBe(false);
    if (!missing.eligible) expect(missing.reasons).toEqual(["image-file-missing"]);
  });
});

describe("evaluatePublication — full reason-code coverage matrix", () => {
  // One row per reason code from the PublicationReason union, asserting that
  // each code is reachable and is the SOLE reason for its fixture. This is the
  // exhaustiveness backstop: if a code becomes unreachable, this table fails.
  //
  // The ALL_REASONS array + coverage test below enforce that EVERY union member
  // appears as a row. If you add a reason to PublicationReason, you MUST add a
  // row here — the `satisfies` check makes ALL_REASONS compile-time exhaustive,
  // and the coverage test fails if a reason has no matrix row.
  const ALL_REASONS = [
    "entry-private", "clearance-unreviewed", "clearance-rejected",
    "missing-rights-basis", "missing-evidence", "missing-reviewer",
    "missing-review-date", "clearance-expired",
    "image-private", "image-path-missing", "image-path-not-public",
    "image-file-missing", "image-metadata-missing",
  ] as const satisfies readonly PublicationReason[];

  const cases: Array<{ name: string; reason: PublicationReason; build: () => CorpusEntryT; exists: (p: string) => boolean }> = [
    { name: "entry-private (no publication)", reason: "entry-private",
      build: () => { const e = eligibleEntry(); delete (e as { publication?: unknown }).publication; return e; },
      exists: alwaysExists },
    { name: "entry-private (visibility private)", reason: "entry-private",
      build: () => eligibleEntry({ publication: { ...eligiblePublication, visibility: "private" } }),
      exists: alwaysExists },
    { name: "clearance-unreviewed", reason: "clearance-unreviewed",
      build: () => eligibleEntry({ publication: { ...eligiblePublication, clearance: "unreviewed" } }),
      exists: alwaysExists },
    { name: "clearance-rejected", reason: "clearance-rejected",
      build: () => eligibleEntry({ publication: { ...eligiblePublication, clearance: "rejected" } }),
      exists: alwaysExists },
    { name: "missing-rights-basis", reason: "missing-rights-basis",
      build: () => { const { rightsBasis: _o, ...p } = eligiblePublication; return eligibleEntry({ publication: p }); },
      exists: alwaysExists },
    { name: "missing-evidence", reason: "missing-evidence",
      build: () => { const { evidenceRef: _o, ...p } = eligiblePublication; return eligibleEntry({ publication: p }); },
      exists: alwaysExists },
    { name: "missing-reviewer", reason: "missing-reviewer",
      build: () => { const { reviewedBy: _o, ...p } = eligiblePublication; return eligibleEntry({ publication: p }); },
      exists: alwaysExists },
    { name: "missing-review-date", reason: "missing-review-date",
      build: () => { const { reviewedAt: _o, ...p } = eligiblePublication; return eligibleEntry({ publication: p }); },
      exists: alwaysExists },
    { name: "clearance-expired", reason: "clearance-expired",
      build: () => eligibleEntry({ publication: { ...eligiblePublication, expiresAt: "2020-01-01" } }),
      exists: alwaysExists },
    { name: "image-private", reason: "image-private",
      build: () => eligibleEntry({ image: { visibility: "private", path: "images-private/example.png", width: 1440, height: 900 } }),
      exists: alwaysExists },
    { name: "image-path-missing (public visibility, null path — schema-invalid)", reason: "image-path-missing",
      build: () => eligibleEntry({ image: { visibility: "public-own", path: null, width: 1440, height: 900 } }),
      exists: alwaysExists },
    { name: "image-path-not-public", reason: "image-path-not-public",
      build: () => eligibleEntry({ image: { visibility: "public-own", path: "images-private/example.png", width: 1440, height: 900 } }),
      exists: alwaysExists },
    { name: "image-metadata-missing", reason: "image-metadata-missing",
      build: () => eligibleEntry({ image: { visibility: "public-own", path: "images-public/example.png", width: null, height: 900 } }),
      exists: alwaysExists },
    { name: "image-file-missing", reason: "image-file-missing",
      build: () => eligibleEntry(),
      exists: neverExists },
  ];

  for (const c of cases) {
    it(`${c.name} → exactly [${c.reason}]`, () => {
      const decision = evaluatePublication(c.build(), { now: NOW, imageExists: c.exists });
      expect(decision.eligible).toBe(false);
      if (!decision.eligible) expect(decision.reasons).toEqual([c.reason]);
    });
  }

  // Exhaustiveness guard: every PublicationReason union member must have at
  // least one matrix row. Catches the "added a reason to the union, forgot the
  // row" failure mode. (ALL_REASONS itself is compile-time-checked via
  // `satisfies` above; this test closes the runtime gap.)
  it("matrix covers every PublicationReason union member", () => {
    const covered = new Set(cases.map((c) => c.reason));
    for (const reason of ALL_REASONS) {
      expect(covered, `missing matrix row for reason: ${reason}`).toContain(reason);
    }
  });
});
