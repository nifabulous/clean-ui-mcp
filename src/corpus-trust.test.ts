import { describe, expect, it } from "vitest";
import { isVerified, verifiedFields, verifiedMethodFor, trustedEvidenceIdsOf } from "./corpus-trust.js";
import { CorpusEntry, type CorpusEntryT } from "./schema.js";

/** A minimal entry. Only `provenance` matters to the predicate. */
function entry(verification?: Record<string, unknown>): CorpusEntryT {
  return {
    id: "e1",
    provenance: verification === undefined
      ? { taggedBy: "auto" }
      : { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

const VALID = {
  method: "image-confirmed",
  verifiedAt: "2026-08-04",
  verifierVersion: "verifier-v1",
  imageSha256: "a".repeat(64),
};

describe("isVerified — per-field, fail-closed", () => {
  it("verifies only the field the record names", () => {
    const e = entry({ "visual.colorRoles": VALID });
    expect(isVerified(e, "visual.colorRoles")).toBe(true);
    expect(isVerified(e, "critique")).toBe(false);
    expect(isVerified(e, "whatToSteal")).toBe(false);
  });

  it("verifies measured and provable records with no imageSha256", () => {
    for (const method of ["measured", "provable"]) {
      const e = entry({ critique: { method, verifiedAt: "2026-08-04", verifierVersion: "v1" } });
      expect(isVerified(e, "critique"), method).toBe(true);
    }
  });

  it("refuses an entry with no verification record", () => {
    expect(isVerified(entry(), "critique")).toBe(false);
  });

  it("refuses an unrecognised method (a newer verifier's tier)", () => {
    const e = entry({ critique: { ...VALID, method: "vibes-confirmed" } });
    expect(isVerified(e, "critique")).toBe(false);
  });

  it("refuses image-confirmed with no imageSha256 — malformed record", () => {
    const { imageSha256: _drop, ...noHash } = VALID;
    const e = entry({ critique: noHash });
    expect(isVerified(e, "critique")).toBe(false);
  });

  it("never consults taggedBy or reviewStatus", () => {
    for (const taggedBy of ["auto", "auto-reviewed", "human"]) {
      const e = {
        id: "e1",
        provenance: { taggedBy, reviewedBy: "someone", verification: { critique: VALID } },
      } as unknown as CorpusEntryT;
      expect(isVerified(e, "critique"), taggedBy).toBe(true);
    }
  });

  it("performs no I/O — a bogus image path changes nothing", () => {
    const e = {
      id: "e1",
      image: { path: "images-private/gone.png" },
      provenance: { taggedBy: "auto", verification: { critique: VALID } },
    };
    expect(isVerified(e as unknown as CorpusEntryT, "critique")).toBe(true);
  });
});

describe("verifiedFields", () => {
  it("returns exactly the valid keys", () => {
    const e = entry({
      "visual.colorRoles": VALID,
      critique: { ...VALID, method: "measured" },
      layout: { ...VALID, method: "vibes-confirmed" }, // invalid method
    });
    expect([...verifiedFields(e)].sort()).toEqual(["critique", "visual.colorRoles"]);
  });

  it("returns an empty set when nothing is verified", () => {
    expect([...verifiedFields(entry())]).toEqual([]);
  });
});

describe("trustedEvidenceIdsOf — per-field bridge", () => {
  it("returns only entries verified for the named field", () => {
    const pairs = [
      { evidenceId: "evidence-2", entry: entry({ critique: VALID }) },
      { evidenceId: "evidence-3", entry: entry({ "visual.colorRoles": VALID }) },
      { evidenceId: "evidence-4", entry: entry({ critique: { ...VALID, method: "measured" } }) },
    ];
    expect(trustedEvidenceIdsOf(pairs, "critique")).toEqual(new Set(["evidence-2", "evidence-4"]));
    expect(trustedEvidenceIdsOf(pairs, "visual.colorRoles")).toEqual(new Set(["evidence-3"]));
  });
});

describe("verifiedMethodFor — disclosure of the evidence tier", () => {
  it("returns the record method only when verified", () => {
    const e = entry({
      platform: { method: "provable", verifiedAt: "x", verifierVersion: "v1" },
      layout: { method: "image-confirmed", verifiedAt: "x", verifierVersion: "v1", imageSha256: "a".repeat(64) },
      critique: { method: "nope", verifiedAt: "x", verifierVersion: "v1" },
    });
    expect(verifiedMethodFor(e, "platform")).toBe("provable");
    expect(verifiedMethodFor(e, "layout")).toBe("image-confirmed");
    expect(verifiedMethodFor(e, "critique")).toBeNull(); // unknown method
    expect(verifiedMethodFor(e, "mood")).toBeNull(); // no record
  });
});

// ---------------------------------------------------------------------------
// Forward compatibility THROUGH Zod (review round)
// ---------------------------------------------------------------------------
describe("provenance.verification map — forward compatibility through the schema", () => {
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

  it("accepts and verifies a per-field map this build knows", () => {
    const r = parse({ critique: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(true);
    expect(isVerified(r.data!, "whatToSteal")).toBe(false);
  });

  it("LOADS a tier a newer verifier introduces, then refuses it per field", () => {
    const r = parse({ critique: { method: "dom-measured", verifiedAt: "2026-08-04", verifierVersion: "v9" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(false);
  });

  it("LOADS an unknown map key, then reads it as not verified", () => {
    const r = parse({ "visual.vibes": { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v9" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "visual.vibes")).toBe(false);
  });

  it("LOADS a record carrying an unknown field, then judges it on method alone", () => {
    const r = parse({ critique: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v9", confidence: 0.9 } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(true);
  });

  it("still refuses image-confirmed with no hash after a real parse", () => {
    const r = parse({ critique: { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(false);
  });

  it("still rejects a malformed imageSha256 at the schema, where shape is checked", () => {
    const r = parse({ critique: { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1", imageSha256: "nope" } });
    expect(r.success).toBe(false);
  });
});
