import { describe, expect, it } from "vitest";
import { isVerified, trustedEvidenceIdsOf } from "./corpus-trust.js";
import type { CorpusEntryT } from "./schema.js";

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
