import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "../schema.js";
import type { LoadedCorpus } from "../persistence.js";
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
