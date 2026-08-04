import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "../schema.js";
import type { LoadedCorpus } from "../persistence.js";
import { corpusDefectCheck, summarizeCorpusDefects } from "./doctor-helpers.js";
import {
  loaderHealthCheck,
  publicationCheck,
  summarizeLoaderHealth,
  summarizePublication,
  type Check,
} from "./doctor-helpers.js";

// doctor.ts is a script that runs to completion at import time (it ends in
// process.exit), so it cannot be imported into a test. The Task 6 diagnostics
// are extracted into doctor-helpers.ts as PURE functions; these tests exercise
// them directly with fixtures. The check objects they return are exactly what
// doctor.ts pushes into its `checks` array, so what's tested here is what ships
// in the human-readable report AND the `--json` output.

// ── fixture builders ──────────────────────────────────────────────────────────
// A fully-eligible entry is the base; each test spreads it and overrides one
// axis to trigger a single reason code. Mirrors the fixtures in policy.test.ts
// so this suite stays consistent with the policy evaluator's contract.

const ELIGIBLE_PUBLICATION = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "docs/rights/example.md",
  reviewedAt: "2026-06-01",
  reviewedBy: "nifabulous",
};

const ELIGIBLE_IMAGE = {
  visibility: "public-own" as const,
  path: "images-public/example.png",
  width: 1440,
  height: 900,
};

function eligibleEntry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
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
    image: { ...ELIGIBLE_IMAGE },
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
    publication: { ...ELIGIBLE_PUBLICATION },
    ...overrides,
  } as CorpusEntryT;
}

const NOW = "2026-07-12";
const alwaysExists = () => true;

// ── summarizePublication ──────────────────────────────────────────────────────

describe("summarizePublication", () => {
  it("counts an all-eligible corpus as eligible, zero everywhere else", () => {
    const s = summarizePublication(
      [eligibleEntry(), eligibleEntry(), eligibleEntry()],
      { now: NOW, imageExists: alwaysExists },
    );
    expect(s).toEqual({
      eligible: 3,
      private: 0,
      unreviewed: 0,
      rejected: 0,
      missingEvidence: 0,
      expired: 0,
      imagePrivate: 0,
    });
  });

  it("counts entry-private when publication block is absent", () => {
    const e = eligibleEntry();
    delete (e as { publication?: unknown }).publication;
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.private).toBe(1);
    expect(s.eligible).toBe(0);
  });

  it("counts entry-private when visibility is private", () => {
    const e = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, visibility: "private" },
    });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.private).toBe(1);
  });

  it("counts clearance-unreviewed", () => {
    const e = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, clearance: "unreviewed" },
    });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.unreviewed).toBe(1);
  });

  it("counts clearance-rejected", () => {
    const e = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, clearance: "rejected" },
    });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.rejected).toBe(1);
  });

  it("counts clearance-expired (expiresAt before now)", () => {
    const e = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, expiresAt: "2026-06-30" },
    });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.expired).toBe(1);
  });

  it("counts image-private when the image is private", () => {
    const e = eligibleEntry({
      image: { visibility: "private", path: "images-private/example.png", width: 1440, height: 900 },
    });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.imagePrivate).toBe(1);
  });

  it("counts missingEvidence when any single evidence field is blank", () => {
    const { evidenceRef: _omit, ...pub } = ELIGIBLE_PUBLICATION;
    const e = eligibleEntry({ publication: pub });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.missingEvidence).toBe(1);
  });

  it("counts missingEvidence ONCE per entry even when several evidence fields are blank", () => {
    // The policy emits missing-rights-basis + missing-evidence + missing-reviewer
    // for one entry; the summary bucket counts the entry once, not three times.
    const { rightsBasis: _r, evidenceRef: _e, reviewedBy: _rb, ...pub } = ELIGIBLE_PUBLICATION;
    const e = eligibleEntry({ publication: pub });
    const s = summarizePublication([e], { now: NOW, imageExists: alwaysExists });
    expect(s.missingEvidence).toBe(1);
  });

  it("tallies a mixed corpus across all buckets", () => {
    const privateEntry = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, visibility: "private" },
    });
    const unreviewedEntry = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, clearance: "unreviewed" },
    });
    const rejectedEntry = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, clearance: "rejected" },
    });
    const expiredEntry = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, expiresAt: "2026-06-30" },
    });
    const imagePrivateEntry = eligibleEntry({
      image: { visibility: "private", path: "images-private/example.png", width: 1440, height: 900 },
    });
    const s = summarizePublication(
      [eligibleEntry(), privateEntry, unreviewedEntry, rejectedEntry, expiredEntry, imagePrivateEntry],
      { now: NOW, imageExists: alwaysExists },
    );
    expect(s).toEqual({
      eligible: 1,
      private: 1,
      unreviewed: 1,
      rejected: 1,
      missingEvidence: 0,
      expired: 1,
      imagePrivate: 1,
    });
  });

  it("reports zero across the board for an empty corpus", () => {
    const s = summarizePublication([], { now: NOW, imageExists: alwaysExists });
    expect(s).toEqual({
      eligible: 0,
      private: 0,
      unreviewed: 0,
      rejected: 0,
      missingEvidence: 0,
      expired: 0,
      imagePrivate: 0,
    });
  });
});

// ── publicationCheck ──────────────────────────────────────────────────────────

describe("publicationCheck", () => {
  it("WARNs when no entry is eligible (the nothing-to-publish case)", () => {
    const privateEntry = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, visibility: "private" },
    });
    const check = publicationCheck([privateEntry], { now: NOW, imageExists: alwaysExists });
    expect(check.name).toBe("Publication pipeline");
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("nothing to publish");
  });

  it("WARNs (empty-corpus variant) for an empty corpus", () => {
    const check = publicationCheck([], { now: NOW, imageExists: alwaysExists });
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("empty corpus");
  });

  it("PASSes when at least one entry is eligible", () => {
    const check = publicationCheck(
      [eligibleEntry(), eligibleEntry()],
      { now: NOW, imageExists: alwaysExists },
    );
    expect(check.status).toBe("PASS");
    expect(check.detail).toContain("2/2 eligible");
  });

  it("surfaces the stable reason-code slugs in the detail line (versioned contract)", () => {
    const e = eligibleEntry({
      publication: { ...ELIGIBLE_PUBLICATION, clearance: "rejected" },
    });
    const check = publicationCheck([eligibleEntry(), e], { now: NOW, imageExists: alwaysExists });
    expect(check.detail).toContain("clearance-rejected:1");
    expect(check.detail).toContain("1/2 eligible");
  });

  it("omits zero-count buckets from the detail line", () => {
    const check = publicationCheck([eligibleEntry()], { now: NOW, imageExists: alwaysExists });
    expect(check.detail).toBe("1/1 eligible to publish");
  });

  it("returns a Check object with the exact keys doctor.ts serializes", () => {
    const check: Check = publicationCheck([eligibleEntry()], { now: NOW, imageExists: alwaysExists });
    // The --json output serializes the checks array verbatim, so the shape
    // (name/status/detail) must be stable.
    expect(Object.keys(check).sort()).toEqual(["detail", "name", "status"]);
  });
});

// ── summarizeLoaderHealth ─────────────────────────────────────────────────────

function loaded(overrides: Partial<LoadedCorpus> = {}): LoadedCorpus {
  return {
    entries: [eligibleEntry()],
    source: "primary",
    writable: true,
    version: 2,
    ...overrides,
  };
}

describe("summarizeLoaderHealth", () => {
  it("projects primary provenance", () => {
    const h = summarizeLoaderHealth(loaded({ source: "primary", writable: true }));
    expect(h).toEqual({ source: "primary", writable: true, version: 2, entryCount: 1 });
  });

  it("projects snapshot provenance", () => {
    const h = summarizeLoaderHealth(loaded({ source: "snapshot", writable: false }));
    expect(h).toEqual({ source: "snapshot", writable: false, version: 2, entryCount: 1 });
  });

  it("projects seed provenance", () => {
    const h = summarizeLoaderHealth(loaded({ source: "seed", writable: false }));
    expect(h).toEqual({ source: "seed", writable: false, version: 2, entryCount: 1 });
  });

  it("projects empty provenance", () => {
    const h = summarizeLoaderHealth(loaded({ source: "empty", entries: [], writable: false }));
    expect(h).toEqual({ source: "empty", writable: false, version: 2, entryCount: 0 });
  });

  it("reflects entryCount and version from the loaded corpus", () => {
    const h = summarizeLoaderHealth(
      loaded({ entries: [eligibleEntry(), eligibleEntry(), eligibleEntry()], version: 2 }),
    );
    expect(h.entryCount).toBe(3);
    expect(h.version).toBe(2);
  });
});

// ── loaderHealthCheck ─────────────────────────────────────────────────────────

describe("loaderHealthCheck", () => {
  it("PASSes for primary (the curator's working corpus is loaded)", () => {
    const check = loaderHealthCheck(loaded({ source: "primary", writable: true }));
    expect(check.name).toBe("Corpus loader source");
    expect(check.status).toBe("PASS");
    expect(check.detail).toContain("source:primary");
    expect(check.detail).toContain("writable");
  });

  it("WARNs for snapshot (running on recovered data)", () => {
    const check = loaderHealthCheck(loaded({ source: "snapshot", writable: false }));
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("source:snapshot");
    expect(check.detail).toContain("read-only");
    expect(check.detail).toContain("recovered");
  });

  it("FAILs for seed (curator's working corpus is missing)", () => {
    const check = loaderHealthCheck(loaded({ source: "seed", writable: false }));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("source:seed");
    expect(check.detail).toContain("missing");
  });

  it("FAILs for empty (no corpus at all)", () => {
    const check = loaderHealthCheck(loaded({ source: "empty", entries: [], writable: false }));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("source:empty");
  });

  it("includes version and entryCount in the detail line", () => {
    const check = loaderHealthCheck(
      loaded({ source: "primary", entries: [eligibleEntry(), eligibleEntry()], version: 2 }),
    );
    expect(check.detail).toContain("v2");
    expect(check.detail).toContain("2 entries");
  });

  it("returns a Check object with the exact keys doctor.ts serializes", () => {
    const check: Check = loaderHealthCheck(loaded({ source: "primary" }));
    expect(Object.keys(check).sort()).toEqual(["detail", "name", "status"]);
  });
});

// ── Corpus defect detectors (C3 trust gate, Stage 1 Task 5) ───────────────────
//
// These eight detectors found 733 of 787 real entries defective. They REPORT
// ONLY: they never write `provenance.verification` and never un-gate anything.
// Alan's wholly-fabricated critique trips zero of them, so mechanical
// cleanliness is necessary and not sufficient — granting trust from these checks
// would re-ship the same fabrication class with a trust label attached.

const CLEAN_ROLES = {
  canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
};

function defectEntry(id: string, overrides: Record<string, unknown> = {}): CorpusEntryT {
  const base = eligibleEntry({ id } as Partial<CorpusEntryT>);
  return {
    ...base,
    layout: { form: "three-column", regions: [] },
    visual: { ...(base.visual as Record<string, unknown>), accentColor: "#2563eb", colorRoles: CLEAN_ROLES },
    ...overrides,
  } as unknown as CorpusEntryT;
}

const VERIFICATION = {
  method: "image-confirmed" as const,
  verifiedAt: "2026-08-04",
  verifierVersion: "v1",
  imageSha256: "a".repeat(64),
};

/** No image is ever read in these tests; the detector's I/O is injected. */
const NO_IMAGES = { imageExists: () => false, imageSha256: () => null };
const ALL_IMAGES = { imageExists: () => true, imageSha256: () => "a".repeat(64) };

describe("summarizeCorpusDefects", () => {
  it("reports role collapse, accent disagreement and fabricated hex", () => {
    const entries = [
      // ink === canvas: text the same colour as its background.
      defectEntry("bad-roles", {
        visual: { accentColor: "#d25859", colorRoles: { canvas: "#403c44", surface: "#808080", ink: "#403c44", muted: "#909090", accent: "#d25859" } },
      }),
      // The two accent fields disagree.
      defectEntry("bad-accent", { visual: { accentColor: "#403c44", colorRoles: CLEAN_ROLES } }),
      // The critique cites a hex present in no colour field.
      defectEntry("bad-hex", {
        critique: "The deep plum-gray #90b5e8 canvas reduces eye strain across long working sessions without losing contrast.",
      }),
    ];
    const findings = summarizeCorpusDefects(entries, ALL_IMAGES);
    const byId = (id: string) => findings.filter((f) => f.id === id).map((f) => f.detector);
    expect(byId("bad-roles")).toContain("role-collapse");
    expect(byId("bad-accent")).toContain("accent-mismatch");
    expect(byId("bad-hex")).toContain("fabricated-hex");
  });

  it("counts a fabricated hex once per colour, not once per mention", () => {
    // The real corpus has entries citing the same unrecorded hex twice in one
    // critique. Two rows for one defect inflates the tally and reads as two
    // problems, so the finding is per (entry, colour).
    const entries = [defectEntry("repeat-hex", {
      critique: "The #90b5e8 header sits above the table, and the same #90b5e8 tint returns in the footer band below it.",
    })];
    const hits = summarizeCorpusDefects(entries, ALL_IMAGES).filter((f) => f.detector === "fabricated-hex");
    expect(hits).toHaveLength(1);
  });

  it("reports ink-on-canvas contrast below 3:1", () => {
    const entries = [defectEntry("low-contrast", {
      visual: { accentColor: "#2563eb", colorRoles: { ...CLEAN_ROLES, canvas: "#6b7280", ink: "#808080" } },
    })];
    expect(summarizeCorpusDefects(entries, ALL_IMAGES).map((f) => f.detector)).toContain("low-contrast");
  });

  it("reports a rail region on a portrait or mobile entry", () => {
    const entries = [defectEntry("mobile-rail", {
      image: { visibility: "public-own", path: "images-public/mobile-rail.png", width: 390, height: 844 },
      layout: { form: "single-column", regions: [{ role: "primary-nav" }, { role: "detail-rail" }] },
    })];
    expect(summarizeCorpusDefects(entries, ALL_IMAGES).map((f) => f.detector)).toContain("rail-on-portrait");
  });

  it("reports monospace claimed in prose with no mono face recorded", () => {
    const entries = [defectEntry("mono-claim", {
      critique: "Numeric columns use a monospace face so digits align cleanly down the whole ledger column.",
    })];
    expect(summarizeCorpusDefects(entries, ALL_IMAGES).map((f) => f.detector)).toContain("mono-unrecorded");
  });

  it("reports soft-neumorphic with usesShadows false", () => {
    const entries = [defectEntry("neu", {
      styleTags: ["soft-neumorphic"],
      visual: { accentColor: "#2563eb", colorRoles: CLEAN_ROLES, usesShadows: false },
    })];
    expect(summarizeCorpusDefects(entries, ALL_IMAGES).map((f) => f.detector)).toContain("neumorphic-no-shadow");
  });

  it("reports unassessed quality defaults", () => {
    const entries = [defectEntry("unassessed", {
      qualityScore: 3, qualityTier: "exceptional",
      provenance: { taggedBy: "auto" },
    })];
    expect(summarizeCorpusDefects(entries, ALL_IMAGES).map((f) => f.detector)).toContain("unassessed-quality");
  });

  it("reports a verified entry whose image file is missing", () => {
    // The serve-path gate is pure and cannot see this; doctor.ts owns it.
    const entries = [defectEntry("verified-no-image", {
      image: { visibility: "private", path: "images-private/definitely-absent.png", width: 10, height: 10 },
      provenance: { taggedBy: "auto", verification: VERIFICATION },
    })];
    const findings = summarizeCorpusDefects(entries, NO_IMAGES);
    expect(findings.some((f) => f.id === "verified-no-image" && f.detector === "verified-image-missing")).toBe(true);
  });

  it("reports a verified entry whose imageSha256 no longer matches the bytes on disk", () => {
    const entries = [defectEntry("verified-stale-hash", {
      provenance: { taggedBy: "auto", verification: VERIFICATION },
    })];
    const findings = summarizeCorpusDefects(entries, {
      imageExists: () => true,
      imageSha256: () => "b".repeat(64),
    });
    expect(findings.some((f) => f.detector === "verified-hash-stale")).toBe(true);
  });

  it("stays silent on a clean entry, and never inspects images of unverified ones", () => {
    let hashCalls = 0;
    const clean = defectEntry("clean", {
      critique: "Restrained borders separate the dense regions and the accent stays reserved for the primary action only.",
      qualityScore: 4,
      provenance: { taggedBy: "auto-reviewed" },
    });
    const findings = summarizeCorpusDefects([clean], {
      imageExists: () => true,
      imageSha256: () => { hashCalls += 1; return "a".repeat(64); },
    });
    expect(findings, JSON.stringify(findings)).toEqual([]);
    // Hashing every image would make the doctor read the whole corpus off disk;
    // only VERIFIED entries have a hash worth comparing.
    expect(hashCalls).toBe(0);
  });
});

describe("corpusDefectCheck", () => {
  it("PASSes a clean corpus and WARNs with per-detector tallies otherwise", () => {
    const clean = defectEntry("clean-2", {
      critique: "Restrained borders separate the dense regions and the accent stays reserved for the primary action only.",
      qualityScore: 4,
      provenance: { taggedBy: "auto-reviewed" },
    });
    expect(corpusDefectCheck([clean], ALL_IMAGES).status).toBe("PASS");

    const dirty = defectEntry("dirty", { visual: { accentColor: "#403c44", colorRoles: CLEAN_ROLES } });
    const check = corpusDefectCheck([clean, dirty], ALL_IMAGES);
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("accent-mismatch:1");
    // Report-only: the check must never claim it fixed or verified anything.
    expect(check.detail).not.toMatch(/verified|fixed/i);
  });
});
