// src/verification-carry.test.ts
//
// Task 3: an update must neither DESTROY earned verification evidence nor let it
// certify a value it never checked.
//
// The bug this fixes had both failure modes at once. `stampProvenance` rebuilt
// `provenance` from four keys while the schema declares seven, so every UI save
// silently discarded `verification`, `verifyAttempts` and `dataQuality` — ~447
// records that cost real vision calls. But the naive fix (preserve everything) is
// WORSE than the bug: a retag re-extracts values, so carrying the old records
// forward would serve freshly-changed text as verified against stale evidence.
//
// The correct rule, and what these tests pin: records come from the STORED entry,
// never the request, and survive only for fields whose value did not change.
import { describe, expect, it } from "vitest";
import {
  carryVerification,
  valueAtFieldKey,
  sameClaim,
} from "./verification-carry.js";
import { isVerified } from "./corpus-trust.js";
import { CorpusEntry } from "./schema.js";
import { stampProvenance } from "./scripts/ui-server.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

const record = (seed: string) => ({
  method: "image-confirmed",
  verifiedAt: "2026-08-09T00:00:00.000Z",
  verifierVersion: "verifier-v1",
  imageSha256: seed.repeat(64).slice(0, 64),
});

const stored = (over: Record<string, unknown> = {}) => ({
  ...fixtures[0],
  image: { ...fixtures[0].image, path: "images-private/sample-5.png" },
  provenance: {
    taggedBy: "auto" as const,
    taggedAt: "2026-07-01",
    capture: {
      mode: "section" as const,
      viewport: "desktop",
      capturedAt: "2026-07-01T00:00:00.000Z",
      sourceUrl: "https://example.com",
    },
    verification: {
      critique: record("a"),
      "visual.usesBorders": record("b"),
      categories: record("c"),
    },
    verifyAttempts: { critique: { attempts: 1, lastAttemptAt: "2026-07-01T00:00:00.000Z" } },
    dataQuality: {},
  },
  ...over,
});

describe("valueAtFieldKey", () => {
  it("reads a top-level field", () => {
    expect(valueAtFieldKey(stored() as never, "categories")).toEqual(fixtures[0].categories);
  });

  it("reads a nested field", () => {
    expect(valueAtFieldKey(stored() as never, "visual.usesBorders")).toBe(fixtures[0].visual.usesBorders);
  });

  it("returns undefined for an absent field rather than throwing", () => {
    expect(valueAtFieldKey(stored() as never, "visual.nope.deeper")).toBeUndefined();
  });
});

describe("sameClaim", () => {
  it("is insensitive to key order at every depth", () => {
    expect(sameClaim({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
  });

  it("is SENSITIVE to array order — dominantColors is ranked", () => {
    expect(sameClaim(["#111111", "#ffffff"], ["#ffffff", "#111111"])).toBe(false);
  });

  it("distinguishes null from absent", () => {
    expect(sameClaim({ a: null }, {})).toBe(false);
  });

  it("treats undefined and absent as the same", () => {
    expect(sameClaim({ a: undefined }, {})).toBe(true);
  });

  it("compares primitives", () => {
    expect(sameClaim(true, true)).toBe(true);
    expect(sameClaim(true, false)).toBe(false);
    expect(sameClaim("x", "x")).toBe(true);
  });
});

describe("carryVerification keeps evidence for unchanged fields", () => {
  it("carries every record when nothing changed", () => {
    const prior = stored();
    const next = { ...stored(), provenance: { taggedBy: "auto" as const } };
    const out = carryVerification(next as never, prior as never);
    expect(Object.keys(out.provenance?.verification ?? {}).sort())
      .toEqual(["categories", "critique", "visual.usesBorders"]);
  });

  it("carries verifyAttempts by exact value, not merely 'defined'", () => {
    const out = carryVerification(
      { ...stored(), provenance: { taggedBy: "auto" as const } } as never,
      stored() as never,
    );
    expect(out.provenance?.verifyAttempts).toEqual({
      critique: { attempts: 1, lastAttemptAt: "2026-07-01T00:00:00.000Z" },
    });
  });

  // All three maps are field-keyed, so all three are filtered by changed value.
  // Carrying verifyAttempts wholesale would let a stale entry SUPPRESS
  // re-verification of the value that just changed (alreadyProcessedAtVersion),
  // and a carried dataQuality finding asserts a contradiction about text that no
  // longer exists.
  it("drops a verifyAttempts entry whose field changed", () => {
    const next = stored({ critique: "Rewritten critique text that comfortably clears the schema minimum." });
    const out = carryVerification(next as never, stored() as never);
    expect(out.provenance?.verifyAttempts?.critique).toBeUndefined();
  });

  it("drops a dataQuality finding whose field changed", () => {
    const prior = stored({
      provenance: {
        ...stored().provenance,
        dataQuality: { critique: { detector: "model", recorded: "old", measured: "x", detectedAt: "2026-07-01T00:00:00.000Z", verifierVersion: "verifier-v1" } },
      },
    });
    const unchanged = carryVerification(stored() as never, prior as never);
    expect(unchanged.provenance?.dataQuality?.critique).toBeDefined();

    const next = stored({ critique: "Rewritten critique text that comfortably clears the schema minimum." });
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.dataQuality?.critique).toBeUndefined();
  });

  it("preserves capture and taggedAt", () => {
    const out = carryVerification(
      { ...stored(), provenance: { taggedBy: "auto-reviewed" as const } } as never,
      stored() as never,
    );
    expect(out.provenance?.capture?.sourceUrl).toBe("https://example.com");
    expect(out.provenance?.taggedAt).toBe("2026-07-01");
  });

  it("does not overwrite a taggedBy the caller already set", () => {
    const out = carryVerification(
      { ...stored(), provenance: { taggedBy: "auto-reviewed" as const } } as never,
      stored() as never,
    );
    expect(out.provenance?.taggedBy).toBe("auto-reviewed");
  });
});

describe("carryVerification drops evidence for CHANGED fields", () => {
  it("drops the record for a field whose value changed", () => {
    const prior = stored();
    const next = stored({ critique: "A completely rewritten critique, long enough to satisfy the schema floor." });
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.verification?.critique).toBeUndefined();
    // untouched fields keep theirs
    expect(out.provenance?.verification?.["visual.usesBorders"]).toBeDefined();
  });

  it("drops a nested field's record when that value changed", () => {
    const prior = stored();
    const next = stored({ visual: { ...fixtures[0].visual, usesBorders: !fixtures[0].visual.usesBorders } });
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.verification?.["visual.usesBorders"]).toBeUndefined();
    expect(out.provenance?.verification?.critique).toBeDefined();
  });

  it("drops the record when a field is removed entirely", () => {
    const prior = stored();
    const next = stored() as Record<string, unknown>;
    delete next.categories;
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.verification?.categories).toBeUndefined();
  });

  it("the dropped field is genuinely unverified afterwards", () => {
    const next = stored({ critique: "A completely rewritten critique, long enough to satisfy the schema floor." });
    const out = carryVerification(next as never, stored() as never);
    expect(isVerified(out, "critique")).toBe(false);
    expect(isVerified(out, "visual.usesBorders")).toBe(true);
  });

  it("reordering a ranked array counts as a change", () => {
    const prior = stored({
      provenance: { ...stored().provenance, verification: { "visual.dominantColors": record("d") } },
    });
    const next = stored({
      visual: { ...fixtures[0].visual, dominantColors: [...fixtures[0].visual.dominantColors].reverse() },
    });
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.verification?.["visual.dominantColors"]).toBeUndefined();
  });
});

describe("records come from the STORED entry, never the request", () => {
  // The PUT path builds its entry wholly from the client body. Without this rule a
  // caller could post a verification map and have it served as trust — the same
  // hole the create path refuses outright.
  it("ignores a verification map on the incoming entry", () => {
    const prior = stored({ provenance: { taggedBy: "auto" as const, verification: {} } });
    const injected = stored({
      provenance: {
        taggedBy: "auto" as const,
        verification: { critique: record("f"), "visual.cornerStyle": record("e") },
      },
    });
    const out = carryVerification(injected as never, prior as never);
    expect(out.provenance?.verification ?? {}).toEqual({});
  });

  it("an injected record cannot survive even when the value is unchanged", () => {
    const prior = stored({ provenance: { taggedBy: "auto" as const } });
    const injected = stored({
      provenance: { taggedBy: "auto" as const, verification: { critique: record("g") } },
    });
    expect(isVerified(carryVerification(injected as never, prior as never), "critique")).toBe(false);
  });

  it("does not mutate either argument", () => {
    const prior = stored();
    const next = stored({ critique: "Rewritten critique text that comfortably clears the schema minimum." });
    carryVerification(next as never, prior as never);
    expect(Object.keys(prior.provenance.verification).sort())
      .toEqual(["categories", "critique", "visual.usesBorders"]);
    expect(next.provenance.verification.critique).toBeDefined();
  });
});

describe("edge cases", () => {
  it("handles a prior entry with no provenance", () => {
    const prior = stored() as Record<string, unknown>;
    delete prior.provenance;
    const out = carryVerification(stored() as never, prior as never);
    expect(out.provenance?.verification ?? {}).toEqual({});
  });

  it("handles a prior entry with no verification map", () => {
    const prior = stored({ provenance: { taggedBy: "auto" as const } });
    const out = carryVerification(stored() as never, prior as never);
    expect(out.provenance?.verification ?? {}).toEqual({});
  });

  it("drops a record under a key nothing serves", () => {
    // isVerified already refuses these; carrying one forward would leave an
    // orphan the doctor reports as verification-orphan-key.
    const prior = stored({
      provenance: { ...stored().provenance, verification: { "visual.madeUpKey": record("h") } },
    });
    const out = carryVerification(stored() as never, prior as never);
    expect(out.provenance?.verification?.["visual.madeUpKey"]).toBeUndefined();
  });
});

// The reported bug itself: stampProvenance rebuilt provenance from four keys while
// the schema declares seven. These assert the three trust keys survive a stamp on
// every mode the server uses.
describe("stampProvenance no longer discards the trust keys", () => {
  it.each([
    ["auto", {}],
    ["auto-reviewed", {}],
    ["auto", { advanceTaggedAt: true }],
  ] as const)("mode %s preserves verification, verifyAttempts and dataQuality", (mode, opts) => {
    const entry = stored() as never as Parameters<typeof stampProvenance>[0];
    stampProvenance(entry, "2026-08-09", mode as "auto" | "auto-reviewed", opts);
    expect(Object.keys(entry.provenance?.verification ?? {}).sort())
      .toEqual(["categories", "critique", "visual.usesBorders"]);
    expect(entry.provenance?.verifyAttempts).toBeDefined();
    expect(entry.provenance?.dataQuality).toBeDefined();
  });

  it("still preserves capture and reviewedBy", () => {
    const entry = stored() as never as Parameters<typeof stampProvenance>[0];
    stampProvenance(entry, "2026-08-09", "auto-reviewed");
    expect(entry.provenance?.capture?.sourceUrl).toBe("https://example.com");
  });

  it("still sets taggedBy, and advances taggedAt only when it should", () => {
    const a = stored() as never as Parameters<typeof stampProvenance>[0];
    stampProvenance(a, "2026-08-09", "auto");
    expect(a.provenance?.taggedBy).toBe("auto");
    expect(a.provenance?.taggedAt).toBe("2026-08-09"); // "auto" advances

    const b = stored() as never as Parameters<typeof stampProvenance>[0];
    stampProvenance(b, "2026-08-09", "auto-reviewed");
    expect(b.provenance?.taggedBy).toBe("auto-reviewed");
    expect(b.provenance?.taggedAt).toBe("2026-07-01"); // a human edit does not
  });

  it("works on an entry with no prior provenance", () => {
    const bare = { ...stored() } as Record<string, unknown>;
    delete bare.provenance;
    const entry = bare as never as Parameters<typeof stampProvenance>[0];
    stampProvenance(entry, "2026-08-09", "auto");
    expect(entry.provenance?.taggedBy).toBe("auto");
    expect(entry.provenance?.verification).toBeUndefined();
  });
});

describe("container keys compare the claim, not the whole container", () => {
  // The verifier's `antiPatterns` claim is only antiPatterns.antiPatterns;
  // accessibilityRisks has its own key and its own record. Comparing the whole
  // container would revoke the parent record whenever a sibling changed.
  const withBoth = (over: Record<string, unknown> = {}) => stored({
    provenance: {
      ...stored().provenance,
      verification: { antiPatterns: record("i"), "antiPatterns.accessibilityRisks": record("j") },
    },
    ...over,
  });

  it("editing accessibilityRisks does not revoke the antiPatterns record", () => {
    const prior = withBoth();
    const next = withBoth({
      antiPatterns: {
        ...fixtures[0].antiPatterns,
        accessibilityRisks: [{ element: "chip", risk: "colour only", evidence: "red dot", confidence: "visible", wcag: ["1.4.1"] }],
      },
    });
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.verification?.antiPatterns).toBeDefined();
    expect(out.provenance?.verification?.["antiPatterns.accessibilityRisks"]).toBeUndefined();
  });

  it("editing the prose list revokes the antiPatterns record but not the risks record", () => {
    const prior = withBoth();
    const next = withBoth({
      antiPatterns: { ...fixtures[0].antiPatterns, antiPatterns: ["A different anti-pattern entirely."] },
    });
    const out = carryVerification(next as never, prior as never);
    expect(out.provenance?.verification?.antiPatterns).toBeUndefined();
    expect(out.provenance?.verification?.["antiPatterns.accessibilityRisks"]).toBeDefined();
  });
});

describe("absent prior — the PUT path with no stored provenance", () => {
  const bare = () => {
    const e = { ...stored() } as Record<string, unknown>;
    delete e.provenance;
    return e;
  };

  it("produces no provenance at all rather than an invalid one", () => {
    // An empty `verification: {}` on an entry that never had provenance would
    // yield a provenance object with no taggedBy, which the schema rejects.
    const out = carryVerification(bare() as never, undefined);
    expect(out.provenance).toBeUndefined();
  });

  it("the result still parses against the schema", () => {
    expect(CorpusEntry.safeParse(carryVerification(bare() as never, undefined)).success).toBe(true);
  });

  it("drops all three injected maps when there is no prior", () => {
    const injected = stored({
      provenance: {
        taggedBy: "auto" as const,
        verification: { critique: record("k") },
        verifyAttempts: { critique: { attempts: 9, lastAttemptAt: "2026-08-09T00:00:00.000Z" } },
        dataQuality: { critique: { detector: "model", recorded: "x", measured: "y", detectedAt: "2026-08-09T00:00:00.000Z", verifierVersion: "verifier-v1" } },
      },
    });
    const out = carryVerification(injected as never, undefined);
    expect(out.provenance?.verification).toBeUndefined();
    expect(out.provenance?.verifyAttempts).toBeUndefined();
    expect(out.provenance?.dataQuality).toBeUndefined();
    expect(out.provenance?.taggedBy).toBe("auto");
  });
});

describe("an incoming record cannot replace a stored one under the same key", () => {
  it("keeps the STORED record's bytes, not the request's", () => {
    const prior = stored();
    const forged = stored({
      provenance: { ...stored().provenance, verification: { critique: record("z") } },
    });
    const out = carryVerification(forged as never, prior as never);
    expect(out.provenance?.verification?.critique).toEqual(prior.provenance.verification.critique);
    expect(out.provenance?.verification?.critique).not.toEqual(record("z"));
  });
});
