import { describe, expect, it } from "vitest";
import { isVerified, trustedEvidenceIdsOf } from "./corpus-trust.js";
import { CorpusEntry, type CorpusEntryT } from "./schema.js";

/** A minimal entry. Only `provenance` matters to the predicate. */
function entry(provenance?: unknown): CorpusEntryT {
  return { id: "e1", provenance } as unknown as CorpusEntryT;
}

const VALID = {
  method: "image-confirmed",
  verifiedAt: "2026-08-04",
  verifierVersion: "verifier-v1",
  imageSha256: "a".repeat(64),
};

describe("isVerified — fail-closed predicate", () => {
  it("verifies a well-formed image-confirmed record", () => {
    expect(isVerified(entry({ taggedBy: "auto", verification: VALID }))).toBe(true);
  });

  it("verifies measured and provable records with no imageSha256", () => {
    for (const method of ["measured", "provable"]) {
      const v = { method, verifiedAt: "2026-08-04", verifierVersion: "verifier-v1" };
      expect(isVerified(entry({ taggedBy: "auto", verification: v })), method).toBe(true);
    }
  });

  it("refuses an entry with no verification record", () => {
    expect(isVerified(entry({ taggedBy: "auto" }))).toBe(false);
  });

  it("refuses an entry with no provenance at all", () => {
    expect(isVerified(entry(undefined))).toBe(false);
  });

  it("refuses an unrecognised method (a newer verifier's tier)", () => {
    const v = { ...VALID, method: "vibes-confirmed" };
    expect(isVerified(entry({ taggedBy: "auto", verification: v }))).toBe(false);
  });

  it("refuses image-confirmed with no imageSha256 — malformed record", () => {
    const { imageSha256: _drop, ...noHash } = VALID;
    expect(isVerified(entry({ taggedBy: "auto", verification: noHash }))).toBe(false);
  });

  // The two fields that look like trust signals and are not.
  it("never consults taggedBy or reviewStatus", () => {
    for (const taggedBy of ["auto", "auto-reviewed", "human"]) {
      expect(isVerified(entry({ taggedBy, reviewedBy: "someone" })), taggedBy).toBe(false);
      expect(
        isVerified(entry({ taggedBy, reviewedBy: "someone", verification: VALID })),
        taggedBy,
      ).toBe(true);
    }
  });

  it("performs no I/O — a bogus image path changes nothing", () => {
    const e = {
      id: "e1",
      image: { path: "images-private/gone.png" },
      provenance: { taggedBy: "auto", verification: VALID },
    };
    expect(isVerified(e as unknown as CorpusEntryT)).toBe(true);
  });

  it("trustedEvidenceIdsOf returns only verified entries' ids", () => {
    const pairs = [
      { evidenceId: "evidence-2", entry: entry({ taggedBy: "auto", verification: VALID }) },
      { evidenceId: "evidence-3", entry: entry({ taggedBy: "auto" }) },
      {
        evidenceId: "evidence-4",
        entry: entry({ taggedBy: "auto", verification: { ...VALID, method: "measured" } }),
      },
    ];
    expect(trustedEvidenceIdsOf(pairs)).toEqual(new Set(["evidence-2", "evidence-4"]));
  });
});

// ---------------------------------------------------------------------------
// Forward compatibility THROUGH Zod (review round)
// ---------------------------------------------------------------------------
//
// The tests above cast through `as unknown as CorpusEntryT`, which bypasses Zod
// entirely. That gave false confidence at exactly the schema seam: a newer
// verifier's tier must LOAD and then be refused by the predicate, but a
// `z.enum` + `.strict()` record fails validation and `corpus-reader.ts` throws
// on a failed parse — refusing the WHOLE corpus rather than one entry. These
// cases go through the real schema.

describe("provenance.verification — forward compatibility through the schema", () => {
  const base = {
    id: "schema-entry",
    title: "Example — dashboard",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: { productName: "Example", url: "https://example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/e.png", width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#2563eb",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
    },
    critique: "This example uses restrained contrast and quiet borders to keep a dense layout readable without decorative noise.",
    whatToSteal: ["Use low-contrast borders to separate dense regions."],
    antiPatterns: { antiPatterns: ["Avoids drop shadows."], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
  };

  function parse(verification: unknown) {
    return CorpusEntry.safeParse({ ...base, provenance: { taggedBy: "auto", verification } });
  }

  it("accepts and verifies a tier this build knows", () => {
    const r = parse({ method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!)).toBe(true);
  });

  it("LOADS a tier a newer verifier introduces, then refuses it", () => {
    // The whole point of fail-closed forward compatibility: an old build must be
    // able to READ a corpus a newer verifier wrote, and decline the rows it does
    // not understand. If the schema rejects the record, the reader throws and the
    // entire corpus is unavailable — a much worse failure than one refused entry.
    const r = parse({ method: "dom-measured", verifiedAt: "2026-08-04", verifierVersion: "v9" });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!)).toBe(false);
  });

  it("LOADS a record carrying an unknown field, then judges it on method alone", () => {
    const r = parse({ method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v9", confidence: 0.9 });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!)).toBe(true);
  });

  it("still refuses image-confirmed with no hash after a real parse", () => {
    const r = parse({ method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1" });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!)).toBe(false);
  });

  it("still rejects a malformed imageSha256 at the schema, where shape is checked", () => {
    // Shape checks that do NOT gate readability stay strict: a non-hex hash is a
    // writer bug, not a newer tier, and there is nothing to be forward-compatible
    // with.
    const r = parse({ method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1", imageSha256: "nope" });
    expect(r.success).toBe(false);
  });
});
