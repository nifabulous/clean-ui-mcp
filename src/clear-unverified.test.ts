// src/clear-unverified.test.ts
//
// Task 4: remove values that serve today and that no lane will ever verify.
//
// Tasks 1-3 stopped NEW bad data. They left the existing corpus alone, which is
// where the measured error lives: `visual.usesShadows` is recorded on 787/787 and
// hand labels put it 6/10 wrong (n=10, directional). The field is `gated`, so the
// ~768 entries with no verification record will never be checked by any lane.
//
// The rule: clear a gated field ONLY where it is unverified. The entries holding
// real evidence keep their values — this removes guesses, not evidence.
import { describe, expect, it } from "vitest";
import { clearUnverified } from "./clear-unverified.js";
import { isVerified, GATED_FIELDS } from "./corpus-trust.js";
import { CorpusEntry } from "./schema.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

const record = () => ({
  method: "image-confirmed",
  verifiedAt: "2026-08-09T00:00:00.000Z",
  verifierVersion: "verifier-v1",
  imageSha256: "a".repeat(64),
});

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  ...fixtures[0],
  id,
  image: { ...fixtures[0].image, path: "images-private/sample-5.png" },
  visual: { ...fixtures[0].visual, usesShadows: true },
  ...over,
});

const verified = (id: string, over: Record<string, unknown> = {}) => entry(id, {
  provenance: { taggedBy: "auto" as const, verification: { "visual.usesShadows": record() } },
  ...over,
});

describe("clearUnverified selects only unverified entries", () => {
  it("clears the unverified and keeps the verified", () => {
    const out = clearUnverified([entry("a"), verified("b"), entry("c")] as never, "visual.usesShadows");
    expect(out.cleared).toBe(2);
    expect(out.kept).toBe(1);
    expect(out.entries[0].visual.usesShadows).toBeNull();
    expect(out.entries[1].visual.usesShadows).toBe(true); // has evidence
    expect(out.entries[2].visual.usesShadows).toBeNull();
  });

  it("uses isVerified, so a record with an unrecognised method does not protect a value", () => {
    const bogus = entry("bogus", {
      provenance: { taggedBy: "auto" as const, verification: { "visual.usesShadows": { ...record(), method: "vibes" } } },
    });
    expect(isVerified(bogus as never, "visual.usesShadows")).toBe(false);
    expect(clearUnverified([bogus] as never, "visual.usesShadows").cleared).toBe(1);
  });

  it("an image-confirmed record with no imageSha256 does not protect a value", () => {
    const unbound = entry("unbound", {
      provenance: {
        taggedBy: "auto" as const,
        verification: { "visual.usesShadows": { method: "image-confirmed", verifiedAt: "x", verifierVersion: "verifier-v1" } },
      },
    });
    expect(clearUnverified([unbound] as never, "visual.usesShadows").cleared).toBe(1);
  });

  it("does not count an already-absent value as cleared", () => {
    const already = entry("already", { visual: { ...fixtures[0].visual, usesShadows: null } });
    const out = clearUnverified([already] as never, "visual.usesShadows");
    expect(out.cleared).toBe(0);
    expect(out.alreadyAbsent).toBe(1);
  });

  it("is idempotent — a second run clears nothing", () => {
    const first = clearUnverified([entry("a"), entry("b")] as never, "visual.usesShadows");
    const second = clearUnverified(first.entries, "visual.usesShadows");
    expect(second.cleared).toBe(0);
    expect(second.entries).toEqual(first.entries);
  });

  it("does not mutate its input", () => {
    const input = [entry("a")] as never as Parameters<typeof clearUnverified>[0];
    clearUnverified(input, "visual.usesShadows");
    expect(input[0].visual.usesShadows).toBe(true);
  });

  it("leaves every other field untouched", () => {
    const before = entry("a");
    const after = clearUnverified([before] as never, "visual.usesShadows").entries[0];
    expect(after.critique).toBe(before.critique);
    expect(after.visual.usesBorders).toBe(before.visual.usesBorders);
    expect(after.visual.dominantColors).toEqual(before.visual.dominantColors);
    expect(after.categories).toEqual(before.categories);
  });

  it("produces entries that still parse", () => {
    const out = clearUnverified([entry("a"), verified("b")] as never, "visual.usesShadows");
    for (const e of out.entries) expect(CorpusEntry.safeParse(e).success).toBe(true);
  });
});

describe("clearUnverified refuses to touch anything but a gated field", () => {
  // A non-gated field still has a lane that can verify it, so clearing it would
  // destroy data the verifier is about to confirm. Only fields where BOTH lanes
  // are exhausted are eligible.
  it.each(["critique", "visual.usesBorders", "components", "categories"])(
    "refuses %s", (field) => {
      expect(() => clearUnverified([entry("a")] as never, field)).toThrow(/not gated/i);
    },
  );

  it("accepts every gated field", () => {
    for (const field of GATED_FIELDS) {
      expect(() => clearUnverified([entry("a")] as never, field)).not.toThrow();
    }
  });
});

describe("clearUnverified respects each field's clear mode", () => {
  it("nulls a nullable field", () => {
    const out = clearUnverified([entry("a", { visual: { ...fixtures[0].visual, accentColor: "#3d1ae0" } })] as never, "visual.accentColor");
    expect(out.entries[0].visual.accentColor).toBeNull();
  });

  it("omits an optional-only field", () => {
    const out = clearUnverified([entry("a", { responsiveBehavior: "responsive" })] as never, "responsiveBehavior");
    expect("responsiveBehavior" in (out.entries[0] as Record<string, unknown>)).toBe(false);
    expect(out.cleared).toBe(1);
  });
});

describe("the report is per-entry, not just a count", () => {
  // A count is not a measurement. The script prints ids so the change is
  // reviewable, and so a re-run can be diffed against it.
  it("lists the ids it cleared", () => {
    const out = clearUnverified([entry("aa"), verified("bb"), entry("cc")] as never, "visual.usesShadows");
    expect(out.clearedIds).toEqual(["aa", "cc"]);
  });

  it("lists the ids it kept, with the method that protected them", () => {
    const out = clearUnverified([entry("aa"), verified("bb")] as never, "visual.usesShadows");
    expect(out.keptIds).toEqual([{ id: "bb", method: "image-confirmed" }]);
  });
});
